import { HttpException } from '@nestjs/common';
import { FakeJob, FakeQueue } from '../../test/fake-queue.js';
import { TriageQueueService, type QueueLike } from '../queue/triage-queue.service.js';
import { JobsController, STATUS_UNAVAILABLE } from './jobs.controller.js';

const ID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const DATA = { subject: 's', body: 'b', received_at: '2026-11-20T10:00:00.000Z' };

function setup(queue: FakeQueue) {
  return new JobsController(new TriageQueueService(queue as QueueLike, 40));
}

async function failure(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected the call to fail');
}

function withJob(state: string, patch: Partial<FakeJob> = {}) {
  const queue = new FakeQueue();
  queue.jobs.set(ID, Object.assign(new FakeJob(DATA, state), patch));
  return setup(queue);
}

describe('JobsController.get', () => {
  it.each(['waiting', 'delayed', 'prioritized', 'waiting-children'])('%s -> queued', async (state) => {
    expect(await withJob(state).get(ID)).toEqual({
      job_id: ID,
      status: 'queued',
      received_at: DATA.received_at,
    });
  });

  it('active -> running', async () => {
    expect(await withJob('active').get(ID)).toEqual({
      job_id: ID,
      status: 'running',
      received_at: DATA.received_at,
    });
  });

  it('completed -> done, with the return value as result', async () => {
    const controller = withJob('completed', { returnvalue: { category: 'billing' } });
    expect(await controller.get(ID)).toEqual({
      job_id: ID,
      status: 'done',
      received_at: DATA.received_at,
      result: { category: 'billing' },
    });
  });

  it('failed -> failed, with a short one-line error and no stack', async () => {
    const controller = withJob('failed', {
      failedReason: 'Python service returned 500\n    at Worker.run (/app/dist/worker.js:10:5)',
    });
    const body = await controller.get(ID);
    expect(body).toEqual({
      job_id: ID,
      status: 'failed',
      received_at: DATA.received_at,
      error: 'Python service returned 500',
    });
  });

  it('a job that finishes between the two reads still shows its final result', async () => {
    // First read: job still running, no result yet. It then completes. Second read: final.
    const before = new FakeJob(DATA, 'completed'); // getState() answers after it finished
    before.returnvalue = null;
    const after = new FakeJob(DATA, 'completed');
    after.returnvalue = { category: 'billing' };
    const queue = new FakeQueue();
    const reads = [before, after];
    queue.getJob = () => Promise.resolve(reads.shift());

    expect(await setup(queue).get(ID)).toEqual({
      job_id: ID,
      status: 'done',
      received_at: DATA.received_at,
      result: { category: 'billing' },
    });
  });

  it('the same for a job that fails between the two reads', async () => {
    const before = new FakeJob(DATA, 'failed');
    const after = new FakeJob(DATA, 'failed');
    after.failedReason = 'rejected by triage service (422)';
    const queue = new FakeQueue();
    const reads = [before, after];
    queue.getJob = () => Promise.resolve(reads.shift());

    expect(await setup(queue).get(ID)).toMatchObject({
      status: 'failed',
      error: 'rejected by triage service (422)',
    });
  });

  it('result and error are absent unless done or failed', async () => {
    const body = await withJob('active', { returnvalue: 'x', failedReason: 'y' }).get(ID);
    expect(body).not.toHaveProperty('result');
    expect(body).not.toHaveProperty('error');
  });

  it('unknown id -> 404 { detail: "Job not found" }', async () => {
    const error = await failure(setup(new FakeQueue()).get(ID));
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({ detail: 'Job not found' });
  });

  it("BullMQ state 'unknown' (job vanished) -> 404", async () => {
    const error = await failure(withJob('unknown').get(ID));
    expect(error.getStatus()).toBe(404);
  });

  it('a state it cannot map -> 500, not a guess', async () => {
    const error = await failure(withJob('some-future-state').get(ID));
    expect(error.getStatus()).toBe(500);
    expect(error.getResponse()).toEqual({ detail: 'Job is in an unexpected state' });
  });

  it.each(['abc', '123', ID + 'x', '../etc/passwd', 'SECRETVALUE123'])(
    'malformed id %s -> 400, not echoed',
    async (id) => {
      const error = await failure(setup(new FakeQueue()).get(id));
      expect(error.getStatus()).toBe(400);
      expect(JSON.stringify(error.getResponse())).not.toContain(id);
    },
  );

  it('queue failure -> 503', async () => {
    const queue = new FakeQueue();
    queue.mode = 'fail';
    const error = await failure(setup(queue).get(ID));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({ detail: STATUS_UNAVAILABLE });
  });

  it('queue hang -> 503 within the timeout', async () => {
    const queue = new FakeQueue();
    queue.mode = 'hang';
    const started = Date.now();
    const error = await failure(setup(queue).get(ID));
    expect(error.getStatus()).toBe(503);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
