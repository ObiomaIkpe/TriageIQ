import type { JobLike, QueueLike, TicketJobData } from '../src/queue/triage-queue.service.js';

export class FakeJob implements JobLike {
  returnvalue: unknown = null;
  failedReason: string | undefined;
  id: string | undefined;
  attemptsMade = 0;
  finishedOn: number | undefined;
  /** What the last retry() was asked to do. */
  retryCalls: { resetAttemptsMade: boolean; resetAttemptsStarted: boolean }[] = [];
  /** Set to make retry() fail, like BullMQ does when the job is no longer failed. */
  retryError: Error | undefined;
  constructor(
    readonly data: TicketJobData,
    public state = 'waiting',
  ) {}
  getState() {
    return Promise.resolve(this.state);
  }
  retry(_state: 'failed', options: { resetAttemptsMade: boolean; resetAttemptsStarted: boolean }) {
    if (this.retryError) return Promise.reject(this.retryError);
    this.retryCalls.push(options);
    this.state = 'waiting';
    return Promise.resolve();
  }
}

/** An in-memory stand-in for the BullMQ queue. `mode` makes it fail or hang on demand. */
export class FakeQueue implements QueueLike {
  jobs = new Map<string, FakeJob>();
  added: { name: string; data: TicketJobData; jobId: string }[] = [];
  /**
   * ok: works. fail: every call fails. hang: connected, but add/getJob never answer.
   * not-ready: the connection is not up yet, so waitUntilReady() waits for becomeReady().
   */
  mode: 'ok' | 'fail' | 'hang' | 'not-ready' = 'ok';
  private readyWaiters: (() => void)[] = [];

  waitUntilReady() {
    if (this.mode === 'fail') {
      return Promise.reject(
        Object.assign(new Error('connect ECONNREFUSED 10.9.9.9:6379'), { code: 'ECONNREFUSED' }),
      );
    }
    if (this.mode === 'not-ready') {
      return new Promise<void>((resolve) => this.readyWaiters.push(resolve));
    }
    return Promise.resolve();
  }

  /** The connection comes up: anything waiting in waitUntilReady() continues. */
  becomeReady() {
    this.mode = 'ok';
    for (const resolve of this.readyWaiters.splice(0)) resolve();
  }

  add(name: string, data: TicketJobData, options: { jobId: string }) {
    if (this.mode === 'fail') {
      return Promise.reject(Object.assign(new Error('connect ECONNREFUSED 10.9.9.9:6379'), { code: 'ECONNREFUSED' }));
    }
    if (this.mode === 'hang') return new Promise<never>(() => undefined);
    this.added.push({ name, data, jobId: options.jobId });
    this.jobs.set(options.jobId, new FakeJob(data));
    return Promise.resolve({ id: options.jobId });
  }

  getJob(id: string) {
    if (this.mode === 'fail') return Promise.reject(new Error('Connection is closed.'));
    if (this.mode === 'hang') return new Promise<never>(() => undefined);
    return Promise.resolve(this.jobs.get(id));
  }

  /** Failed jobs, newest first, like BullMQ's getFailed(). */
  getFailed(start: number, end: number) {
    if (this.mode === 'fail') return Promise.reject(new Error('Connection is closed.'));
    if (this.mode === 'hang') return new Promise<never>(() => undefined);
    const failed = [...this.jobs.entries()]
      .filter(([, job]) => job.state === 'failed')
      .sort(([, a], [, b]) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0))
      .map(([id, job]) => Object.assign(job, { id }));
    return Promise.resolve(failed.slice(start, end + 1));
  }

  getFailedCount() {
    if (this.mode === 'fail') return Promise.reject(new Error('Connection is closed.'));
    if (this.mode === 'hang') return new Promise<never>(() => undefined);
    return Promise.resolve([...this.jobs.values()].filter((job) => job.state === 'failed').length);
  }

  on() {
    return this;
  }
}
