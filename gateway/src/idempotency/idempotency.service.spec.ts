import { FakeQueue } from '../../test/fake-queue.js';
import { TriageQueueService, type QueueLike } from '../queue/triage-queue.service.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import {
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyConflictError,
  IdempotencyService,
} from './idempotency.service.js';

const TICKET = { subject: 'Cannot log in', body: 'I forgot my password.', customer_id: 'c1' };

function setup(queue = new FakeQueue()) {
  const service = new TriageQueueService(queue as QueueLike, 60);
  return { queue, idem: new IdempotencyService(service, queue.kv) };
}

describe('IdempotencyService.submit', () => {
  it('the first request claims the key, queues the job under that id, and is not a replay', async () => {
    const { queue, idem } = setup();
    const result = await idem.submit('k1', TICKET);

    expect(result.replayed).toBe(false);
    expect(queue.added).toHaveLength(1);
    expect(queue.added[0].jobId).toBe(result.jobId);
    const stored = JSON.parse(queue.kv.entries.get('idem:k1')?.value ?? 'null') as Record<string, string>;
    expect(stored.job_id).toBe(result.jobId);
    expect(stored.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(queue.kv.entries.get('idem:k1')?.ttl).toBe(IDEMPOTENCY_TTL_SECONDS);
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(86400);
  });

  it('the same key and ticket again: the same job id, replayed, and no second job', async () => {
    const { queue, idem } = setup();
    const first = await idem.submit('k1', TICKET);
    const second = await idem.submit('k1', { ...TICKET });

    expect(second).toEqual({ jobId: first.jobId, replayed: true });
    expect(queue.added).toHaveLength(1);
  });

  it('whitespace is gone before this point, so the same ticket is the same ticket', async () => {
    const { idem } = setup();
    const a = await idem.submit('k1', { subject: 'a', body: 'b' });
    const b = await idem.submit('k1', { subject: 'a', body: 'b', customer_id: undefined });
    expect(b.jobId).toBe(a.jobId);
  });

  it('the same key with a different ticket -> conflict, and nothing new is queued', async () => {
    const { queue, idem } = setup();
    await idem.submit('k1', TICKET);
    await expect(idem.submit('k1', { ...TICKET, body: 'A different problem.' })).rejects.toThrow(
      IdempotencyConflictError,
    );
    expect(queue.added).toHaveLength(1);
  });

  it('different keys with the same ticket are different jobs', async () => {
    const { queue, idem } = setup();
    const a = await idem.submit('k1', TICKET);
    const b = await idem.submit('k2', TICKET);
    expect(a.jobId).not.toBe(b.jobId);
    expect(queue.added).toHaveLength(2);
  });

  it('five at once with one key: one job, one job id for everyone', async () => {
    const { queue, idem } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => idem.submit('k1', TICKET)));
    expect(queue.added).toHaveLength(1);
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  describe('when queueing fails', () => {
    it('the key is released (only if it still holds this job id), 503 is raised, and a retry works', async () => {
      const { queue, idem } = setup();
      queue.addError = new Error('connect ECONNREFUSED 10.9.9.9:6379');
      await expect(idem.submit('k1', TICKET)).rejects.toThrow(QueueUnavailableError);
      expect(queue.kv.entries.has('idem:k1')).toBe(false);

      queue.addError = undefined;
      const retry = await idem.submit('k1', TICKET);
      expect(retry.replayed).toBe(false);
      expect(queue.added.map((job) => job.jobId)).toEqual([retry.jobId]);
    });

    it('a key someone else has claimed in the meantime is NOT deleted', async () => {
      const { queue, idem } = setup();
      queue.addError = new Error('boom');
      const original = queue.add.bind(queue);
      // While this request is failing, another one replaces the key with its own claim.
      queue.add = (...args: Parameters<typeof original>) => {
        queue.kv.entries.set('idem:k1', {
          value: JSON.stringify({ job_id: 'someone-elses-job', fingerprint: 'f' }),
          ttl: 1,
        });
        return original(...args);
      };
      await expect(idem.submit('k1', TICKET)).rejects.toThrow(QueueUnavailableError);
      expect(JSON.parse(queue.kv.entries.get('idem:k1')?.value ?? 'null').job_id).toBe('someone-elses-job');
    });

    it('if releasing the key fails too, the original error still reaches the caller', async () => {
      const { queue, idem } = setup();
      queue.addError = new Error('boom');
      queue.kv.evalError = new Error('Connection is closed.');
      await expect(idem.submit('k1', TICKET)).rejects.toThrow(QueueUnavailableError);
    });
  });

  it('Redis down -> QueueUnavailableError, nothing claimed', async () => {
    const queue = new FakeQueue();
    queue.mode = 'fail';
    const { idem } = setup(queue);
    await expect(idem.submit('k1', TICKET)).rejects.toThrow(QueueUnavailableError);
    expect(queue.kv.entries.size).toBe(0);
  });

  it('Redis hanging -> QueueUnavailableError within the timeout, nothing claimed', async () => {
    const queue = new FakeQueue();
    queue.mode = 'hang';
    const { idem } = setup(queue);
    const started = Date.now();
    await expect(idem.submit('k1', TICKET)).rejects.toThrow(QueueUnavailableError);
    expect(Date.now() - started).toBeLessThan(250);
    expect(queue.kv.entries.size).toBe(0);
  });

  it('a key that expires between the failed claim and the read is claimed again', async () => {
    const { queue, idem } = setup();
    queue.kv.entries.set('idem:k1', { value: JSON.stringify({ job_id: 'old', fingerprint: 'x' }), ttl: 1 });
    const get = queue.kv.get.bind(queue.kv);
    queue.kv.get = (key: string) => {
      queue.kv.entries.delete(key); // it expires right now
      return get(key);
    };
    const result = await idem.submit('k1', TICKET);
    expect(result.replayed).toBe(false);
    expect(queue.added).toHaveLength(1);
  });
});
