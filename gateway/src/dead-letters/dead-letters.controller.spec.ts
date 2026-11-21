import { HttpException } from '@nestjs/common';
import { FakeJob, FakeQueue } from '../../test/fake-queue.js';
import { TriageQueueService, type QueueLike } from '../queue/triage-queue.service.js';
import { DEAD_LETTERS_UNAVAILABLE, DeadLettersController } from './dead-letters.controller.js';

const ID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup(queue: FakeQueue) {
  return new DeadLettersController(new TriageQueueService(queue as QueueLike, 40));
}

function failedJob(n: number, patch: Partial<FakeJob> = {}) {
  const job = new FakeJob(
    { subject: `subject ${n}`, body: `body ${n}`, customer_id: `c${n}`, received_at: '2026-11-20T10:00:00.000Z' },
    'failed',
  );
  job.attemptsMade = 8;
  job.finishedOn = Date.UTC(2026, 10, 20, 10, 0, n);
  job.failedReason = 'triage service unavailable (503)';
  return Object.assign(job, patch);
}

async function failure(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected the call to fail');
}

describe('DeadLettersController.list', () => {
  it('maps a failed job to the item shape, with the short reason and no stack', async () => {
    const queue = new FakeQueue();
    queue.jobs.set(
      ID,
      failedJob(5, { failedReason: 'triage service unavailable (503)\n    at Worker.run (/app/x.js:1:1)' }),
    );
    const body = await setup(queue).list({});
    expect(body).toEqual({
      items: [
        {
          job_id: ID,
          failed_at: '2026-11-20T10:00:05.000Z',
          received_at: '2026-11-20T10:00:00.000Z',
          attempts_made: 8,
          reason: 'triage service unavailable (503)',
          subject: 'subject 5',
          body: 'body 5',
          customer_id: 'c5',
          client: null, // a job from before API clients existed
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });
  });

  it('shows the client that submitted the job', async () => {
    const queue = new FakeQueue();
    queue.jobs.set(ID, failedJob(1, { data: { subject: 's', body: 'b', received_at: 'r', client: 'alice' } }));
    expect((await setup(queue).list({})).items[0].client).toBe('alice');
  });

  it('customer_id is null when the ticket had none; reason falls back when empty', async () => {
    const queue = new FakeQueue();
    const job = failedJob(1, { failedReason: undefined });
    delete (job.data as { customer_id?: string }).customer_id;
    queue.jobs.set(ID, job);
    const { items } = await setup(queue).list({});
    expect(items[0]).toMatchObject({ customer_id: null, reason: 'Job failed' });
  });

  it('lists only failed jobs, newest failure first, and pages with limit/offset', async () => {
    const queue = new FakeQueue();
    for (const n of [1, 2, 3]) queue.jobs.set(id(n), failedJob(n));
    queue.jobs.set(id(9), new FakeJob({ subject: 's', body: 'b', received_at: 'x' }, 'delayed'));
    const controller = setup(queue);

    const all = await controller.list({});
    expect(all.items.map((item) => item.job_id)).toEqual([id(3), id(2), id(1)]);
    expect(all.total).toBe(3);

    const page = await controller.list({ limit: '1', offset: '1' });
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(page.items.map((item) => item.job_id)).toEqual([id(2)]);

    expect((await controller.list({ offset: '5' })).items).toEqual([]);
  });

  it.each([{ limit: '0' }, { limit: '101' }, { limit: 'x' }, { offset: '-1' }, { limit: ['1', '2'] }])(
    'bad query %j -> 400 with no echoed value',
    async (query) => {
      const error = await failure(setup(new FakeQueue()).list(query));
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({ detail: 'Invalid query' });
    },
  );

  it('queue failure -> 503', async () => {
    const queue = new FakeQueue();
    queue.mode = 'fail';
    const error = await failure(setup(queue).list({}));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({ detail: DEAD_LETTERS_UNAVAILABLE });
  });

  it('queue hang -> 503 within the timeout', async () => {
    const queue = new FakeQueue();
    queue.mode = 'hang';
    const started = Date.now();
    const error = await failure(setup(queue).list({}));
    expect(error.getStatus()).toBe(503);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('DeadLettersController.retry', () => {
  it('a failed job goes back to the queue under the same id, asking BullMQ to reset the attempts', async () => {
    const queue = new FakeQueue();
    const job = failedJob(1);
    queue.jobs.set(ID, job);
    expect(await setup(queue).retry(ID)).toEqual({
      job_id: ID,
      status: 'queued',
      status_url: `/jobs/${ID}`,
    });
    expect(job.retryCalls).toEqual([{ resetAttemptsMade: true, resetAttemptsStarted: true }]);
    expect(queue.jobs.size).toBe(1); // same job, not a copy
  });

  it('the second retry of the same job -> 409, and no second retry is sent', async () => {
    const queue = new FakeQueue();
    const job = failedJob(1);
    queue.jobs.set(ID, job);
    const controller = setup(queue);
    await controller.retry(ID);
    const error = await failure(controller.retry(ID));
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({ detail: 'Job is not in the dead-letter list' });
    expect(job.retryCalls).toHaveLength(1);
  });

  it.each(['waiting', 'delayed', 'active', 'completed'])('a %s job -> 409', async (state) => {
    const queue = new FakeQueue();
    queue.jobs.set(ID, failedJob(1, { state }));
    const error = await failure(setup(queue).retry(ID));
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({ detail: 'Job is not in the dead-letter list' });
  });

  it('a race: the job stops being failed between the check and the retry -> 409', async () => {
    const queue = new FakeQueue();
    const job = failedJob(1);
    job.retry = () => {
      job.state = 'waiting'; // someone else retried it first
      return Promise.reject(new Error(`Job ${ID} is not in the failed state. reprocessJob`));
    };
    queue.jobs.set(ID, job);
    expect((await failure(setup(queue).retry(ID))).getStatus()).toBe(409);
  });

  it('a retry that fails while the job is still failed is not hidden: 503', async () => {
    const queue = new FakeQueue();
    queue.jobs.set(ID, failedJob(1, { retryError: new Error('boom') }));
    expect((await failure(setup(queue).retry(ID))).getStatus()).toBe(503);
  });

  it('unknown id -> 404; state "unknown" -> 404', async () => {
    const error = await failure(setup(new FakeQueue()).retry(ID));
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({ detail: 'Job not found' });

    const queue = new FakeQueue();
    queue.jobs.set(ID, failedJob(1, { state: 'unknown' }));
    expect((await failure(setup(queue).retry(ID))).getStatus()).toBe(404);
  });

  it.each(['abc', '123', ID + 'x', '../etc/passwd', 'SECRETVALUE123'])(
    'malformed id %s -> 400, not echoed',
    async (bad) => {
      const error = await failure(setup(new FakeQueue()).retry(bad));
      expect(error.getStatus()).toBe(400);
      expect(JSON.stringify(error.getResponse())).not.toContain(bad);
    },
  );

  it('queue failure -> 503; queue hang -> 503 within the timeout', async () => {
    const down = new FakeQueue();
    down.mode = 'fail';
    expect((await failure(setup(down).retry(ID))).getStatus()).toBe(503);

    const hung = new FakeQueue();
    hung.mode = 'hang';
    const started = Date.now();
    expect((await failure(setup(hung).retry(ID))).getStatus()).toBe(503);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
