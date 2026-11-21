import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TriageQueueService } from '../queue/triage-queue.service.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import type { TicketInput } from '../tickets/ticket.schema.js';
import { fingerprintTicket } from './idempotency-key.js';
import { IDEMPOTENCY_REDIS, type KeyValueClient } from './idempotency.constants.js';
import { waitUntilReady } from './redis-ready.js';

/** How long a key is remembered. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const IDEMPOTENCY_KEY_PREFIX = 'idem:';

/**
 * Deletes the key only if it still holds THIS job id, in one step inside Redis. A plain
 * GET-then-DEL could delete a key that another request had already claimed in between.
 */
export const COMPARE_AND_DELETE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local ok, decoded = pcall(cjson.decode, value)
if ok and type(decoded) == 'table' and decoded.job_id == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** The key was already used with a different ticket. */
export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different ticket');
    this.name = 'IdempotencyConflictError';
  }
}

export interface SubmitResult {
  jobId: string;
  /** True when the key was already known: no new job was created. */
  replayed: boolean;
  /** The ticket reference this key was answered with. Missing for keys stored before references moved to the gateway. */
  reference?: string;
}

export interface SubmitOptions {
  /** The reference to give a NEW job (and to remember with the key, so a replay returns the same one). */
  reference?: string;
  /** Replaces the default fingerprint (a route whose body has more than a ticket, such as the public form). */
  fingerprint?: string;
  /** Contact details that travel with the job (public form). */
  contact?: { customer_name: string; customer_email: string };
}

/** What a read-only look at a key found. */
export type PeekResult = { kind: 'none' } | { kind: 'replay'; jobId: string; reference?: string };

interface StoredKey {
  job_id: string;
  fingerprint: string;
  reference?: string;
}

/** Claim, replay or reject: the whole rule for a request that carries an Idempotency-Key. */
const MAX_CLAIM_ROUNDS = 3;
const logger = new Logger('Idempotency');

@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(TriageQueueService) private readonly queue: TriageQueueService,
    @Inject(IDEMPOTENCY_REDIS) private readonly redis: KeyValueClient,
  ) {}

  /**
   * Queues the ticket once per key. The first request claims `idem:<client>:<key>` (SET NX EX, atomic)
   * with its job id and the ticket's fingerprint, then queues the job under that id. A later
   * request with the same key gets the same job id back, or a conflict if its ticket differs.
   * Every Redis call has the usual deadline; trouble becomes QueueUnavailableError (503).
   */
  async submit(
    principalId: string,
    key: string,
    ticket: TicketInput,
    ownerId: string = principalId,
    options: SubmitOptions = {},
  ): Promise<SubmitResult> {
    // One namespace per principal ("client:<name>" or "user:<uuid>"): the same Idempotency-Key from two
    // callers is two different keys, and a client can never collide with a user.
    const redisKey = `${IDEMPOTENCY_KEY_PREFIX}${principalId}:${key}`;
    const fingerprint = options.fingerprint ?? fingerprintTicket(ticket);

    for (let round = 0; round < MAX_CLAIM_ROUNDS; round += 1) {
      const jobId = randomUUID();
      const value = JSON.stringify({
        job_id: jobId,
        fingerprint,
        ...(options.reference === undefined ? {} : { reference: options.reference }),
      } satisfies StoredKey);

      const claimed = await this.queue.guarded(async (expired) => {
        await waitUntilReady(this.redis, expired);
        if (expired()) return false; // too late: the caller has already been told 503
        return (
          (await this.redis.set(redisKey, value, 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX')) === 'OK'
        );
      });

      if (claimed) {
        try {
          await this.queue.enqueue(ticket, ownerId, jobId, {
            reference: options.reference,
            customer_name: options.contact?.customer_name,
            customer_email: options.contact?.customer_email,
          });
          return { jobId, replayed: false, reference: options.reference };
        } catch (error) {
          // Nothing was queued, so the key must not keep pointing at a job that does not
          // exist: the client's retry with the same key has to work.
          await this.release(redisKey, jobId);
          throw error;
        }
      }

      const stored = await this.queue.guarded(async (expired) => {
        await waitUntilReady(this.redis, expired);
        return this.redis.get(redisKey);
      });
      if (stored === null) continue; // expired or released since the claim failed: claim again

      const known = parseStored(stored);
      if (known.fingerprint !== fingerprint) throw new IdempotencyConflictError();
      return { jobId: known.job_id, replayed: true, reference: known.reference };
    }
    throw new QueueUnavailableError();
  }

  /**
   * Looks at a key WITHOUT claiming it: the same fingerprint means a completed request (replay: answer with
   * the original job and reference, spend nothing), another fingerprint is a conflict, no key means go on.
   * Cheap on purpose (one GET), so a retry costs no Turnstile call and no limit or cap slot.
   */
  async peek(principalId: string, key: string, fingerprint: string): Promise<PeekResult> {
    const redisKey = `${IDEMPOTENCY_KEY_PREFIX}${principalId}:${key}`;
    const stored = await this.queue.guarded(async (expired) => {
      await waitUntilReady(this.redis, expired);
      return this.redis.get(redisKey);
    });
    if (stored === null) return { kind: 'none' };
    const known = parseStored(stored);
    if (known.fingerprint !== fingerprint) throw new IdempotencyConflictError();
    return { kind: 'replay', jobId: known.job_id, reference: known.reference };
  }

  /** Best effort. If Redis is gone too, the key expires on its own after the TTL. */
  private async release(redisKey: string, jobId: string): Promise<void> {
    try {
      await this.queue.guarded(async (expired) => {
        await waitUntilReady(this.redis, expired);
        return this.redis.eval(COMPARE_AND_DELETE_SCRIPT, 1, redisKey, jobId);
      });
    } catch {
      logger.warn('Could not release an idempotency key after a failed enqueue');
    }
  }
}

function parseStored(raw: string): StoredKey {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredKey).job_id === 'string' &&
    typeof (value as StoredKey).fingerprint === 'string'
  ) {
    const reference = (value as StoredKey).reference;
    return { ...(value as StoredKey), reference: typeof reference === 'string' ? reference : undefined };
  }
  throw new Error('unreadable idempotency record');
}
