import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyConflictError } from '../idempotency/idempotency.service.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import { FakeClock, MemoryPublicStore } from '../../test/memory-stores.js';
import { PublicIntakeService, secondsUntilUtcMidnight, utcDay } from './public-intake.service.js';
import { parsePublicTicket, type PublicTicketInput } from './public-ticket.schema.js';
import type { TurnstileResult } from './turnstile.service.js';

const input = (over: Record<string, unknown> = {}): PublicTicketInput => {
  const r = parsePublicTicket({ name: 'Ada', email: 'ada@example.com', subject: 'Hi', message: 'Help', turnstile_token: 'tok', ...over });
  if (!r.ok) throw new Error('bad fixture');
  return r.data;
};

function setup(settings: { perIp?: number; cap?: number } = {}) {
  const clock = new FakeClock();
  const store = new MemoryPublicStore(clock);
  const log: string[] = [];
  const state = {
    peek: { kind: 'none' } as { kind: 'none' } | { kind: 'replay'; jobId: string; reference?: string } | Error,
    submit: { replayed: false } as { replayed: boolean } | Error,
    turnstile: { kind: 'ok' } as TurnstileResult,
  };
  const idempotency = {
    peek: async () => {
      log.push('peek');
      if (state.peek instanceof Error) throw state.peek;
      return state.peek;
    },
    submit: async (...args: unknown[]) => {
      log.push('submit');
      submitted.push(args);
      if (state.submit instanceof Error) throw state.submit;
      return { jobId: 'job-1', replayed: state.submit.replayed, reference: (args[4] as { reference: string }).reference };
    },
  };
  const submitted: unknown[][] = [];
  const turnstile = { verify: async () => (log.push('turnstile'), state.turnstile) };
  const config = new ConfigService({ PUBLIC_MAX_PER_IP_PER_HOUR: settings.perIp ?? 5, PUBLIC_DAILY_CAP: settings.cap ?? 200 });
  const service = new PublicIntakeService(config as never, idempotency as never, turnstile as never, store as never, clock.fn);
  return { service, store, clock, state, log, submitted };
}

describe('PublicIntakeService order of checks', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('accepts: replay look, IP count, Turnstile, cap, then the claim; reference goes in the job', async () => {
    const out = await t.service.accept(input(), 'key-1', '1.1.1.1');
    expect(out).toEqual({ kind: 'accepted', reference: expect.stringMatching(/^TKT-/) });
    expect(t.log).toEqual(['peek', 'turnstile', 'submit']);
    expect(t.store.calls).toEqual(['hitIp', 'reserveCap']);
    const [principal, key, ticket, owner, options] = t.submitted[0] as [string, string, unknown, string, Record<string, unknown>];
    expect([principal, key, owner]).toEqual(['client:public-form', 'key-1', 'public-form']);
    expect(ticket).toEqual({ subject: 'Hi', body: 'Help', customer_id: 'public-form' });
    expect(options.contact).toEqual({ customer_name: 'Ada', customer_email: 'ada@example.com' });
    expect(options.reference).toBe((out as { reference: string }).reference);
  });

  it('a replay calls nothing else: no limit slot, no Turnstile, no cap, no claim', async () => {
    t.state.peek = { kind: 'replay', jobId: 'j', reference: 'TKT-ABC234' };
    expect(await t.service.accept(input(), 'k', '1.1.1.1')).toEqual({ kind: 'replay', reference: 'TKT-ABC234' });
    expect(t.log).toEqual(['peek']);
    expect(t.store.calls).toEqual([]);
  });

  it('a replay still works from an IP that is over its limit', async () => {
    for (let i = 0; i < 6; i += 1) await t.store.hitIp('1.1.1.1', 3600);
    t.state.peek = { kind: 'replay', jobId: 'j', reference: 'TKT-ABC234' };
    expect((await t.service.accept(input(), 'k', '1.1.1.1')).kind).toBe('replay');
  });

  it('the same key with different content is a conflict and calls nothing else', async () => {
    t.state.peek = new IdempotencyConflictError();
    expect((await t.service.accept(input(), 'k', '1.1.1.1')).kind).toBe('conflict');
    expect(t.log).toEqual(['peek']);
    expect(t.store.calls).toEqual([]);
  });

  it('a honeypot looks like a success, queues nothing, calls no Turnstile and takes no cap slot, but counts toward the IP limit', async () => {
    const out = await t.service.accept(input({ website: 'http://spam' }), 'k', '2.2.2.2');
    expect(out).toEqual({ kind: 'honeypot', reference: expect.stringMatching(/^TKT-[A-HJKMNP-Z2-9]{6}$/) });
    expect(t.log).toEqual(['peek']);
    expect(t.store.calls).toEqual(['hitIp']);
    expect(t.store.ips.get('2.2.2.2')?.count).toBe(1);
  });

  it('a whitespace-only website is not a honeypot hit', async () => {
    expect((await t.service.accept(input({ website: '   ' }), 'k', '1.1.1.1')).kind).toBe('accepted');
  });

  it('a honeypot still answers normally when the counter is down', async () => {
    t.store.failing = 'ip';
    expect((await t.service.accept(input({ website: 'x' }), 'k', '1.1.1.1')).kind).toBe('honeypot');
  });

  it('over the per-IP limit: refused before Turnstile with the seconds left, cap untouched', async () => {
    t = setup({ perIp: 2 });
    for (let i = 0; i < 2; i += 1) expect((await t.service.accept(input(), `k${i}`, '3.3.3.3')).kind).toBe('accepted');
    t.log.length = 0; t.store.calls.length = 0;
    const out = await t.service.accept(input(), 'k3', '3.3.3.3');
    expect(out).toEqual({ kind: 'rate_limited_ip', retryAfterSeconds: 3600 });
    expect(t.log).toEqual(['peek']); // never calls Turnstile
    expect(t.store.calls).toEqual(['hitIp']); // never touches the cap
    expect(t.store.capUsed(utcDay(t.clock.now))).toBe(2);
  });

  it('the limit is per IP and the window ends', async () => {
    t = setup({ perIp: 1 });
    expect((await t.service.accept(input(), 'a', '1.1.1.1')).kind).toBe('accepted');
    expect((await t.service.accept(input(), 'b', '1.1.1.1')).kind).toBe('rate_limited_ip');
    expect((await t.service.accept(input(), 'c', '9.9.9.9')).kind).toBe('accepted');
    t.clock.advanceSeconds(3601);
    expect((await t.service.accept(input(), 'd', '1.1.1.1')).kind).toBe('accepted');
  });

  it('a refused attempt does not extend the window', async () => {
    t = setup({ perIp: 1 });
    await t.service.accept(input(), 'a', '1.1.1.1');
    t.clock.advanceSeconds(1800);
    const out = await t.service.accept(input(), 'b', '1.1.1.1');
    expect(out).toEqual({ kind: 'rate_limited_ip', retryAfterSeconds: 1800 });
  });

  it('a Turnstile failure never touches the daily cap', async () => {
    t.state.turnstile = { kind: 'failed', codes: ['invalid-input-response'] };
    expect(await t.service.accept(input(), 'k', '1.1.1.1')).toEqual({ kind: 'turnstile_failed', codes: ['invalid-input-response'] });
    expect(t.store.calls).toEqual(['hitIp']);
    expect(t.log).toEqual(['peek', 'turnstile']);
  });

  it('bots without a valid token cannot use up the cap, so real customers still get in', async () => {
    t = setup({ cap: 2, perIp: 1000 });
    t.state.turnstile = { kind: 'failed', codes: ['x'] };
    for (let i = 0; i < 50; i += 1) await t.service.accept(input(), `bot${i}`, `10.0.0.${i}`);
    expect(t.store.capUsed(utcDay(t.clock.now))).toBe(0);
    t.state.turnstile = { kind: 'ok' };
    expect((await t.service.accept(input(), 'real', '8.8.8.8')).kind).toBe('accepted');
  });

  it('Turnstile unavailable fails closed and never touches the cap', async () => {
    t.state.turnstile = { kind: 'unavailable', codes: ['unreachable'] };
    expect((await t.service.accept(input(), 'k', '1.1.1.1')).kind).toBe('turnstile_unavailable');
    expect(t.store.calls).toEqual(['hitIp']);
  });

  it('the daily cap refuses with the seconds to the next UTC midnight and never claims the key', async () => {
    t = setup({ cap: 1 });
    expect((await t.service.accept(input(), 'a', '1.1.1.1')).kind).toBe('accepted');
    t.log.length = 0;
    const out = await t.service.accept(input(), 'b', '2.2.2.2');
    expect(out).toEqual({ kind: 'daily_cap', retryAfterSeconds: 12 * 3600 }); // the fake clock starts at 12:00 UTC
    expect(t.log).not.toContain('submit');
  });

  it('a new UTC day has a fresh cap', async () => {
    t = setup({ cap: 1 });
    await t.service.accept(input(), 'a', '1.1.1.1');
    t.clock.advanceSeconds(13 * 3600);
    expect((await t.service.accept(input(), 'b', '2.2.2.2')).kind).toBe('accepted');
  });

  it('gives the cap slot back when the enqueue fails', async () => {
    t.state.submit = new QueueUnavailableError();
    expect((await t.service.accept(input(), 'k', '1.1.1.1')).kind).toBe('unavailable');
    expect(t.store.capUsed(utcDay(t.clock.now))).toBe(0);
    expect(t.store.calls).toEqual(['hitIp', 'reserveCap', 'releaseCap']);
  });

  it('gives the slot back when two identical requests raced and this one lost', async () => {
    t.state.submit = { replayed: true };
    expect((await t.service.accept(input(), 'k', '1.1.1.1')).kind).toBe('replay');
    expect(t.store.capUsed(utcDay(t.clock.now))).toBe(0);
  });

  it('a failing slot give-back does not hide the original answer', async () => {
    t.state.submit = new QueueUnavailableError();
    t.store.failing = 'release';
    expect((await t.service.accept(input(), 'k', '1.1.1.1')).kind).toBe('unavailable');
  });

  it('counter trouble fails closed', async () => {
    t.store.failing = 'ip';
    expect((await t.service.accept(input(), 'k', '1.1.1.1')).kind).toBe('unavailable');
    t = setup();
    t.store.failing = 'cap';
    expect((await t.service.accept(input(), 'k', '1.1.1.1')).kind).toBe('unavailable');
  });

  it('an unexpected error from the queue is not swallowed', async () => {
    t.state.submit = new Error('boom');
    await expect(t.service.accept(input(), 'k', '1.1.1.1')).rejects.toThrow('boom');
    expect(t.store.capUsed(utcDay(t.clock.now))).toBe(0);
  });
});

describe('UTC day helpers', () => {
  it('utcDay and the seconds to midnight', () => {
    const noon = Date.parse('2026-11-21T12:00:00Z');
    expect(utcDay(noon)).toBe('2026-11-21');
    expect(secondsUntilUtcMidnight(noon)).toBe(43200);
    expect(secondsUntilUtcMidnight(Date.parse('2026-11-21T23:59:59.500Z'))).toBe(1);
    expect(secondsUntilUtcMidnight(Date.parse('2026-12-31T23:00:00Z'))).toBe(3600); // across a year end
    expect(utcDay(Date.parse('2026-11-21T23:59:59Z'))).toBe('2026-11-21');
  });
});
