import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';
import { IdempotencyConflictError, IdempotencyService } from '../idempotency/idempotency.service.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import { newReference } from '../tickets/reference.js';
import { fingerprintPublicTicket, type PublicTicketInput } from './public-ticket.schema.js';
import { PUBLIC_STORE, PUBLIC_CLOCK, PUBLIC_FORM_CLIENT, PUBLIC_FORM_CUSTOMER_ID, PUBLIC_FORM_PRINCIPAL_ID, PUBLIC_IP_WINDOW_SECONDS } from './public.constants.js';
import type { PublicStore } from './public-store.js';
import { TurnstileService } from './turnstile.service.js';

export type IntakeOutcome =
  | { kind: 'accepted'; reference: string }
  | { kind: 'replay'; reference: string }
  | { kind: 'honeypot'; reference: string }
  | { kind: 'rate_limited_ip'; retryAfterSeconds: number }
  | { kind: 'turnstile_failed'; codes: string[] }
  | { kind: 'turnstile_unavailable'; codes: string[] }
  | { kind: 'daily_cap'; retryAfterSeconds: number }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

const logger = new Logger('PublicTickets');

/** The UTC date of a moment, "2026-11-21": one cap counter per day. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Whole seconds until the next UTC midnight (at least 1). */
export function secondsUntilUtcMidnight(ms: number): number {
  const next = Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - ms) / 1000));
}

/**
 * The public form's checks, cheapest first and money last. Each step runs only if every earlier one passed:
 *
 *   replay -> honeypot -> per-IP limit -> Turnstile -> daily cap -> idempotency claim + enqueue
 *
 * (The Origin check and the schema run before this, in the controller.) Why this order:
 *  - a replay answers from one Redis read and uses nothing (no limit slot, no Turnstile call, no cap slot);
 *  - the per-IP limit and the honeypot cost nothing, so they come before the Turnstile network call;
 *  - the daily cap comes AFTER Turnstile: a bot with no valid token must never be able to use up the cap and lock
 *    real customers out. Only a request that passed the bot check can take a slot;
 *  - a slot is given back if the ticket is not queued after all.
 * Nothing the customer wrote (name, email, subject, message) and no token or secret is ever logged.
 */
@Injectable()
export class PublicIntakeService {
  private readonly maxPerIp: number;
  private readonly cap: number;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(TurnstileService) private readonly turnstile: TurnstileService,
    @Inject(PUBLIC_STORE) private readonly store: PublicStore,
    @Inject(PUBLIC_CLOCK) private readonly clock: () => number,
  ) {
    this.maxPerIp = config.get('PUBLIC_MAX_PER_IP_PER_HOUR', { infer: true });
    this.cap = config.get('PUBLIC_DAILY_CAP', { infer: true });
  }

  async accept(input: PublicTicketInput, key: string, ip: string): Promise<IntakeOutcome> {
    const fingerprint = fingerprintPublicTicket(input);

    // c. replay: this key already completed with this message. Answer as before, spend nothing.
    try {
      const seen = await this.idempotency.peek(PUBLIC_FORM_PRINCIPAL_ID, key, fingerprint);
      if (seen.kind === 'replay' && seen.reference !== undefined) {
        return this.done({ kind: 'replay', reference: seen.reference }, ip);
      }
    } catch (error) {
      return this.mapFailure(error, ip);
    }

    // d. honeypot: look like a success, queue nothing. It still counts toward the IP's hourly limit.
    if (input.website !== undefined && input.website.trim() !== '') {
      try {
        await this.store.hitIp(ip, PUBLIC_IP_WINDOW_SECONDS);
      } catch {
        // A counter that cannot be reached must not tell the bot anything.
      }
      return this.done({ kind: 'honeypot', reference: newReference() }, ip);
    }

    // e. per-IP limit (counted first, atomically; over the limit means refused with Retry-After).
    try {
      const hit = await this.store.hitIp(ip, PUBLIC_IP_WINDOW_SECONDS);
      if (hit.count > this.maxPerIp) {
        return this.done({ kind: 'rate_limited_ip', retryAfterSeconds: Math.max(1, hit.ttlSeconds) }, ip);
      }
    } catch {
      return this.done({ kind: 'unavailable' }, ip); // fail closed
    }

    // f. Turnstile. Failing closed: if we cannot ask, nobody gets in.
    const verdict = await this.turnstile.verify(input.turnstile_token, ip);
    if (verdict.kind === 'failed') return this.done({ kind: 'turnstile_failed', codes: verdict.codes }, ip);
    if (verdict.kind === 'unavailable') return this.done({ kind: 'turnstile_unavailable', codes: verdict.codes }, ip);

    // g. daily cap: reserve a slot, atomically. Only a request that passed Turnstile gets here.
    const day = utcDay(this.clock());
    try {
      const slot = await this.store.reserveCap(day, this.cap);
      if (!slot.reserved) {
        return this.done({ kind: 'daily_cap', retryAfterSeconds: secondsUntilUtcMidnight(this.clock()) }, ip);
      }
    } catch {
      return this.done({ kind: 'unavailable' }, ip);
    }

    // h. claim the idempotency key and queue the ticket, exactly like POST /tickets. A slot that was not used is given back.
    try {
      const submitted = await this.idempotency.submit(
        PUBLIC_FORM_PRINCIPAL_ID,
        key,
        { subject: input.subject, body: input.message, customer_id: PUBLIC_FORM_CUSTOMER_ID },
        PUBLIC_FORM_CLIENT,
        {
          reference: newReference(),
          fingerprint,
          contact: { customer_name: input.name, customer_email: input.email },
        },
      );
      if (submitted.replayed) {
        // Two identical requests raced: the other one queued it. This one used no ticket, so it gives its slot back.
        await this.giveBack(day);
        return this.done({ kind: 'replay', reference: submitted.reference ?? newReference() }, ip);
      }
      return this.done({ kind: 'accepted', reference: submitted.reference ?? '' }, ip);
    } catch (error) {
      await this.giveBack(day);
      return this.mapFailure(error, ip);
    }
  }

  private async giveBack(day: string): Promise<void> {
    try {
      await this.store.releaseCap(day);
    } catch {
      logger.warn('Could not give a daily cap slot back after a failed enqueue');
    }
  }

  private mapFailure(error: unknown, ip: string): IntakeOutcome {
    if (error instanceof IdempotencyConflictError) return this.done({ kind: 'conflict' }, ip);
    if (error instanceof QueueUnavailableError) return this.done({ kind: 'unavailable' }, ip);
    throw error;
  }

  /** One line per request: the outcome, the reference if there is one, the IP, Turnstile's codes. Nothing the customer wrote. */
  private done(outcome: IntakeOutcome, ip: string): IntakeOutcome {
    const reference = 'reference' in outcome ? ` reference=${outcome.reference}` : '';
    const codes = 'codes' in outcome ? ` turnstile_errors=${outcome.codes.join(',')}` : '';
    const name: Record<IntakeOutcome['kind'], string> = {
      accepted: 'accepted',
      replay: 'replay',
      honeypot: 'honeypot',
      rate_limited_ip: 'rate_limited_ip',
      turnstile_failed: 'turnstile_failed',
      turnstile_unavailable: 'turnstile_unavailable',
      daily_cap: 'daily_cap',
      conflict: 'conflict',
      unavailable: 'unavailable',
    };
    const line = `public_ticket outcome=${name[outcome.kind]}${reference} ip=${ip}${codes}`;
    if (outcome.kind === 'accepted' || outcome.kind === 'replay') logger.log(line);
    else logger.warn(line);
    return outcome;
  }
}
