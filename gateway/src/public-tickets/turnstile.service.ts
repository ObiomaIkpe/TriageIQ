import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';
import { FETCH } from '../health/health.constants.js';
import { DEFAULT_TURNSTILE_RETRY_DELAY_MS, DEFAULT_TURNSTILE_TIMEOUT_MS, TURNSTILE_RETRY_DELAY_MS, TURNSTILE_TIMEOUT_MS } from './public.constants.js';

/**
 * What the verification said.
 *  - ok: Cloudflare says a real visitor passed (and the hostname and action, when checked, match).
 *  - failed: the token is not good (wrong, expired, already used, wrong site or action). `codes` are Cloudflare's
 *    error codes (or "hostname-mismatch" / "action-mismatch"), safe to log.
 *  - unavailable: we could not get a trustworthy answer (Cloudflare unreachable, timed out, 5xx, unreadable, or our own
 *    secret is rejected). The caller FAILS CLOSED.
 */
export type TurnstileResult =
  | { kind: 'ok' }
  | { kind: 'failed'; codes: string[] }
  | { kind: 'unavailable'; codes: string[] };

/** Cloudflare error codes that mean "our side is wrong or Cloudflare is broken", not "this visitor failed". */
const OUR_SIDE_CODES = new Set(['missing-input-secret', 'invalid-input-secret', 'internal-error', 'bad-request']);
const CODE_SAFE = /^[a-z0-9-]{1,64}$/;

const logger = new Logger('Turnstile');

/** The error's name or code only: never its message, which could carry a URL. */
const errorName = (e: unknown): string =>
  typeof e === 'object' && e !== null ? String((e as { code?: unknown }).code ?? (e as { name?: unknown }).name ?? 'error') : 'error';

@Injectable()
export class TurnstileService {
  private readonly secret: string;
  private readonly url: string;
  private readonly hostnames: string[];
  private readonly action: string;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(FETCH) private readonly fetchFn: typeof fetch,
    @Inject(TURNSTILE_TIMEOUT_MS) private readonly timeoutMs: number = DEFAULT_TURNSTILE_TIMEOUT_MS,
    @Optional() @Inject(TURNSTILE_RETRY_DELAY_MS) private readonly retryDelayMs: number = DEFAULT_TURNSTILE_RETRY_DELAY_MS,
  ) {
    this.secret = config.get('TURNSTILE_SECRET_KEY', { infer: true });
    this.url = config.get('TURNSTILE_VERIFY_URL', { infer: true });
    this.hostnames = config.get('TURNSTILE_EXPECTED_HOSTNAMES', { infer: true });
    this.action = config.get('TURNSTILE_EXPECTED_ACTION', { infer: true });
  }

  /** One POST to siteverify. Rejects on a network error or timeout; resolves with whatever Cloudflare answered. */
  private async post(form: URLSearchParams): Promise<{ status: number; text: string }> {
    const response = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status >= 500 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, text: '' };
    }
    return { status: response.status, text: (await response.text()).slice(0, 8192) };
  }

  /** Asks Cloudflare whether this token is good. Never throws, and never logs the token or the secret. */
  async verify(token: string, ip: string): Promise<TurnstileResult> {
    const form = new URLSearchParams({ secret: this.secret, response: token, idempotency_key: randomUUID() });
    if (ip !== 'unknown') form.set('remoteip', ip);

    // One retry, only for a NETWORK failure or a timeout (no answer at all, e.g. the first call after a cold start).
    // Any answer from Cloudflare, good or bad, is final and never retried. The retry reuses the same form, so the same
    // idempotency_key: if the first request did reach Cloudflare, it gets the same result back, not "already used".
    let reply: { status: number; text: string };
    try {
      reply = await this.post(form);
    } catch (first) {
      logger.warn(`Turnstile siteverify got no answer (${errorName(first)}); retrying once in ${this.retryDelayMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      try {
        reply = await this.post(form);
      } catch (second) {
        logger.warn(`Turnstile siteverify retry also got no answer (${errorName(second)}); failing closed`);
        return { kind: 'unavailable', codes: ['unreachable'] };
      }
    }
    if (reply.status >= 500 || (reply.status >= 300 && reply.status < 400)) {
      return { kind: 'unavailable', codes: [`http-${reply.status}`] };
    }
    let body: unknown;
    try {
      body = JSON.parse(reply.text) as unknown;
    } catch {
      return { kind: 'unavailable', codes: ['unreadable'] };
    }

    if (typeof body !== 'object' || body === null || typeof (body as { success?: unknown }).success !== 'boolean') {
      return { kind: 'unavailable', codes: ['unreadable'] };
    }
    const answer = body as { success: boolean; hostname?: unknown; action?: unknown; 'error-codes'?: unknown };
    const codes = Array.isArray(answer['error-codes'])
      ? answer['error-codes'].filter((c): c is string => typeof c === 'string' && CODE_SAFE.test(c)).slice(0, 8)
      : [];

    if (!answer.success) {
      if (codes.some((c) => OUR_SIDE_CODES.has(c))) {
        logger.error(`Turnstile refused the gateway's own request (${codes.join(',')}): check TURNSTILE_SECRET_KEY`);
        return { kind: 'unavailable', codes };
      }
      return { kind: 'failed', codes: codes.length > 0 ? codes : ['unsuccessful'] };
    }
    if (this.hostnames.length > 0) {
      const hostname = typeof answer.hostname === 'string' ? answer.hostname.toLowerCase() : '';
      if (!this.hostnames.includes(hostname)) return { kind: 'failed', codes: ['hostname-mismatch'] };
    }
    if (this.action !== '' && answer.action !== this.action) return { kind: 'failed', codes: ['action-mismatch'] };
    return { kind: 'ok' };
  }
}
