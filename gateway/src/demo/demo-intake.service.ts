import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';
import { IdempotencyConflictError, IdempotencyService } from '../idempotency/idempotency.service.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import type { IntakeOutcome } from '../public-tickets/public-intake.service.js';
import { secondsUntilUtcMidnight, utcDay } from '../public-tickets/public-intake.service.js';
import { PUBLIC_CLOCK, PUBLIC_IP_WINDOW_SECONDS, PUBLIC_STORE } from '../public-tickets/public.constants.js';
import type { PublicStore } from '../public-tickets/public-store.js';
import { TurnstileService } from '../public-tickets/turnstile.service.js';
import { newReference } from '../tickets/reference.js';
import { ReferenceService, ReferenceUnavailableError } from '../tickets/reference.service.js';
import {
  DEMO_CAP_PREFIX,
  DEMO_CUSTOMER_EMAIL,
  DEMO_CUSTOMER_ID,
  DEMO_CUSTOMER_NAME,
  DEMO_FORM_CLIENT,
  DEMO_FORM_PRINCIPAL_ID,
  DEMO_SUBMIT_IP_PREFIX,
} from './demo.constants.js';
import { type DemoTicketInput, fingerprintDemoTicket } from './demo-ticket.schema.js';

const logger = new Logger('DemoTickets');

/**
 * A demo visitor's own test ticket. It is a REAL triage run (real model calls, so real cost), which is why it is guarded as hard as
 * the public form, in the same order, cheapest first and money last:
 *
 *   replay -> per-IP limit -> Turnstile -> DEMO_DAILY_CAP -> idempotency claim + enqueue (marked demo)
 *
 * It uses its OWN counters (demo:submit:ip:, demo:cap:), so demo traffic never uses up the public form's limits or cap and the
 * other way round. The customer is always the fixed "Demo Visitor"; the ticket is saved as a demo ticket (is_demo) and so it is
 * visible to every demo visitor until the nightly reset, and to no real reviewer. Nothing a visitor wrote is logged.
 */
@Injectable()
export class DemoIntakeService {
  private readonly maxPerIp: number;
  private readonly cap: number;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(TurnstileService) private readonly turnstile: TurnstileService,
    @Inject(PUBLIC_STORE) private readonly store: PublicStore,
    @Inject(PUBLIC_CLOCK) private readonly clock: () => number,
    @Inject(ReferenceService) private readonly references: ReferenceService,
  ) {
    this.maxPerIp = config.get('DEMO_SUBMIT_MAX_PER_IP_PER_HOUR', { infer: true });
    this.cap = config.get('DEMO_DAILY_CAP', { infer: true });
  }

  async accept(input: DemoTicketInput, key: string, ip: string): Promise<IntakeOutcome> {
    const fingerprint = fingerprintDemoTicket(input);

    try {
      const seen = await this.idempotency.peek(DEMO_FORM_PRINCIPAL_ID, key, fingerprint);
      if (seen.kind === 'replay' && seen.reference !== undefined) return this.done({ kind: 'replay', reference: seen.reference }, ip);
    } catch (error) {
      return this.mapFailure(error, ip);
    }

    try {
      const hit = await this.store.hitIp(ip, PUBLIC_IP_WINDOW_SECONDS, DEMO_SUBMIT_IP_PREFIX);
      if (hit.count > this.maxPerIp) return this.done({ kind: 'rate_limited_ip', retryAfterSeconds: Math.max(1, hit.ttlSeconds) }, ip);
    } catch {
      return this.done({ kind: 'unavailable' }, ip); // fail closed
    }

    const verdict = await this.turnstile.verify(input.turnstile_token, ip);
    if (verdict.kind === 'failed') return this.done({ kind: 'turnstile_failed', codes: verdict.codes }, ip);
    if (verdict.kind === 'unavailable') return this.done({ kind: 'turnstile_unavailable', codes: verdict.codes }, ip);

    const day = utcDay(this.clock());
    try {
      const slot = await this.store.reserveCap(day, this.cap, DEMO_CAP_PREFIX);
      if (!slot.reserved) return this.done({ kind: 'daily_cap', retryAfterSeconds: secondsUntilUtcMidnight(this.clock()) }, ip);
    } catch {
      return this.done({ kind: 'unavailable' }, ip);
    }

    try {
      const submitted = await this.idempotency.submit(
        DEMO_FORM_PRINCIPAL_ID,
        key,
        { subject: input.subject, body: input.message, customer_id: DEMO_CUSTOMER_ID },
        DEMO_FORM_CLIENT,
        {
          reference: newReference(),
          reserveReference: (first) => this.references.reserve(first),
          fingerprint,
          contact: { customer_name: DEMO_CUSTOMER_NAME, customer_email: DEMO_CUSTOMER_EMAIL },
          demo: true,
        },
      );
      if (submitted.replayed) {
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
      await this.store.releaseCap(day, DEMO_CAP_PREFIX);
    } catch {
      logger.warn('Could not give a demo cap slot back after a failed enqueue');
    }
  }

  private mapFailure(error: unknown, ip: string): IntakeOutcome {
    if (error instanceof IdempotencyConflictError) return this.done({ kind: 'conflict' }, ip);
    if (error instanceof QueueUnavailableError || error instanceof ReferenceUnavailableError) return this.done({ kind: 'unavailable' }, ip);
    throw error;
  }

  private done(outcome: IntakeOutcome, ip: string): IntakeOutcome {
    const reference = 'reference' in outcome ? ` reference=${outcome.reference}` : '';
    const codes = 'codes' in outcome ? ` turnstile_errors=${outcome.codes.join(',')}` : '';
    const line = `demo_ticket outcome=${outcome.kind}${reference} ip=${ip}${codes}`;
    if (outcome.kind === 'accepted' || outcome.kind === 'replay') logger.log(line);
    else logger.warn(line);
    return outcome;
  }
}
