import type { JobLike, QueueLike, TicketJobData } from '../src/queue/triage-queue.service.js';

export class FakeJob implements JobLike {
  returnvalue: unknown = null;
  failedReason: string | undefined;
  constructor(
    readonly data: TicketJobData,
    public state = 'waiting',
  ) {}
  getState() {
    return Promise.resolve(this.state);
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

  on() {
    return this;
  }
}
