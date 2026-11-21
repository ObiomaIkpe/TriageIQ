import { Module } from '@nestjs/common';
import { BACKOFF_BASE_MS, MAX_ATTEMPTS } from '../worker/backoff.js';

/** Injection token for how many times a job is tried and the first backoff step. */
export const TRIAGE_RETRY_POLICY = Symbol('TRIAGE_RETRY_POLICY');

export interface RetryPolicy {
  /** Total tries per job, the first attempt included. */
  attempts: number;
  /** Wait after the first failed attempt; doubles for each further one (up to the cap). */
  backoffBaseMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: MAX_ATTEMPTS,
  backoffBaseMs: BACKOFF_BASE_MS,
};

/**
 * Holds the retry policy. It is not an environment setting on purpose: production always uses
 * the defaults. Tests replace the provider (overrideProvider(TRIAGE_RETRY_POLICY)) so a job
 * can exhaust its attempts in seconds instead of 15 minutes.
 */
@Module({
  providers: [{ provide: TRIAGE_RETRY_POLICY, useValue: DEFAULT_RETRY_POLICY }],
  exports: [TRIAGE_RETRY_POLICY],
})
export class RetryPolicyModule {}
