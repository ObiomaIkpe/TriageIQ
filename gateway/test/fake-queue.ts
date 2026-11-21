import type { KeyValueClient } from '../src/idempotency/idempotency.constants.js';
import { COMPARE_AND_DELETE_SCRIPT } from '../src/idempotency/idempotency.service.js';
import type { JobLike, QueueLike, TicketJobData } from '../src/queue/triage-queue.service.js';

/** An in-memory stand-in for the three Redis commands the idempotency keys use. */
export class FakeKeyValue implements KeyValueClient {
  constructor(private readonly mode: () => 'ok' | 'fail' | 'hang' | 'not-ready' = () => 'ok') {}

  /** Like ioredis: not 'ready' while the connection is down. */
  get status() {
    return this.mode() === 'fail' ? 'reconnecting' : 'ready';
  }

  quit() {
    return Promise.resolve('OK');
  }

  disconnect() {}

  private hangs() {
    return this.mode() === 'hang';
  }

  entries = new Map<string, { value: string; ttl: number }>();
  /** Every write that reached the store, in order, for assertions. */
  log: string[] = [];
  /** Makes the next eval() (the compare-and-delete) fail. */
  evalError: Error | undefined;

  set(key: string, value: string, _expiry: 'EX', seconds: number, _mode: 'NX') {
    if (this.hangs()) return new Promise<never>(() => undefined);
    if (this.entries.has(key)) return Promise.resolve(null);
    this.entries.set(key, { value, ttl: seconds });
    this.log.push(`set ${key}`);
    return Promise.resolve('OK' as const);
  }

  get(key: string) {
    if (this.hangs()) return new Promise<never>(() => undefined);
    return Promise.resolve(this.entries.get(key)?.value ?? null);
  }

  eval(script: string, _numberOfKeys: number, key: string, jobId: string) {
    if (this.hangs()) return new Promise<never>(() => undefined);
    if (this.evalError) return Promise.reject(this.evalError);
    if (script !== COMPARE_AND_DELETE_SCRIPT) return Promise.reject(new Error('unknown script'));
    const entry = this.entries.get(key);
    if (entry && (JSON.parse(entry.value) as { job_id: string }).job_id === jobId) {
      this.entries.delete(key);
      this.log.push(`del ${key}`);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }
}

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
  readonly kv = new FakeKeyValue(() => this.mode);
  /** Makes add() fail once per call while set, like a queue write that errors. */
  addError: Error | undefined;


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
    if (this.addError) return Promise.reject(this.addError);
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
