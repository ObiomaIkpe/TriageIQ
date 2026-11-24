import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { FakeReplyQueue, MemoryDeliveries } from '../../test/mail-fakes.js';
import { ReplyDeliveryService } from './reply-delivery.service.js';
import { ReplySweeper } from './reply-sweeper.js';

const guard = { guarded: async (fn: (expired: () => boolean) => Promise<unknown>) => fn(() => false) };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ticket = (n: number, over: Record<string, unknown> = {}) => ({
  ticket_id: id(n), reference: `TKT-AAAAA${n}`, status: 'approved', customer_email: `c${n}@example.com`, created_at: `2026-11-2${n}T10:00:00Z`, ...over,
});

function setup(python: Record<string, Record<string, unknown>[]>) {
  const deliveries = new MemoryDeliveries();
  const queue = new FakeReplyQueue();
  const calls: { query: Record<string, string>; scope?: string }[] = [];
  const triage = {
    call: async (call: { query: Record<string, string>; scope?: string }) => {
      calls.push(call);
      return { status: 200, body: python[call.query.status!] ?? [] };
    },
  };
  const service = new ReplyDeliveryService(new ConfigService({ MAIL_ENABLED: true }) as never, deliveries as never, queue as never, guard as never);
  return { deliveries, queue, calls, sweeper: new ReplySweeper(triage as never, deliveries as never, service, queue as never) };
}

describe('the sweep', () => {
  it('finds an approved and an edited ticket that were never queued, and queues each once', async () => {
    const t = setup({ approved: [ticket(1)], edited: [ticket(2, { status: 'edited' })] });
    const result = await t.sweeper.run(new Date('2026-11-23T12:00:00Z'));
    expect(result).toMatchObject({ checked: 2, repaired: 2 });
    expect(t.queue.adds.map((a) => a.jobId).sort()).toEqual([id(1), id(2)]);
    expect([...t.deliveries.rows.values()].map((r) => r.status)).toEqual(['queued', 'queued']);
  });

  it('asks Python only for approved/edited tickets reviewed in the last 7 days', async () => {
    const t = setup({});
    await t.sweeper.run(new Date('2026-11-23T12:00:00Z'));
    expect(t.calls.map((c) => [c.query.status, c.query.reviewed_since])).toEqual([
      ['approved', '2026-11-16T12:00:00.000Z'],
      ['edited', '2026-11-16T12:00:00.000Z'],
    ]);
  });

  it('the sweep reads the REAL side of the wall only, so a demo ticket is never found by it', async () => {
    const t = setup({});
    await t.sweeper.run(new Date('2026-11-23T12:00:00Z'));
    expect(t.calls.map((c) => c.scope)).toEqual(['real', 'real']);
  });

  it('and if Python ever listed a demo ticket, the sweep still makes no row and no job for it', async () => {
    const t = setup({ approved: [ticket(1, { is_demo: true })] });
    const result = await t.sweeper.run();
    expect(result).toMatchObject({ checked: 1, repaired: 0 });
    expect(t.deliveries.rows.size).toBe(0);
    expect(t.queue.adds).toEqual([]);
  });

  it('a ticket that already has a delivery row is left alone (running the sweep twice makes one job)', async () => {
    const t = setup({ approved: [ticket(1)] });
    await t.sweeper.run();
    await t.sweeper.run();
    expect(t.queue.adds).toHaveLength(1);
  });

  it('a ticket with no email gets a skipped_no_email row, not a job', async () => {
    const t = setup({ approved: [ticket(1, { customer_email: null })] });
    await t.sweeper.run();
    expect(t.deliveries.rows.get(id(1))?.status).toBe('skipped_no_email');
    expect(t.queue.adds).toEqual([]);
  });

  it('a failure on one ticket does not stop the others, and the next sweep retries it', async () => {
    const t = setup({ approved: [ticket(1), ticket(2)] });
    t.queue.addError = new Error('redis down');
    expect(await t.sweeper.run()).toMatchObject({ checked: 2, repaired: 0 });
    t.queue.addError = undefined;
    expect(await t.sweeper.run()).toMatchObject({ repaired: 2 });
  });

  it('a row stuck as queued for too long gets its job back (a lost job), but not if the job exists', async () => {
    const t = setup({});
    await t.deliveries.insert(id(1), 'TKT-AAAAA1', 'queued');
    await t.deliveries.insert(id(2), 'TKT-AAAAA2', 'queued');
    for (const r of t.deliveries.rows.values()) r.queued_at = new Date(Date.now() - 60 * 60 * 1000);
    await t.queue.add('send', { ticket_id: id(2), reference: 'TKT-AAAAA2' }, { jobId: id(2) });
    t.queue.adds.length = 0;
    expect(await t.sweeper.run()).toMatchObject({ requeued: 1 });
    expect(t.queue.adds.map((a) => a.jobId)).toEqual([id(1)]);
  });
});
