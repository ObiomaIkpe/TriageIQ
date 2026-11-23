import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeReplyQueue, MemoryDeliveries } from '../../test/mail-fakes.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import { ReplyDeliveryService } from './reply-delivery.service.js';

const ID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const ticket = (over: Record<string, unknown> = {}) => ({ ticket_id: ID, reference: 'TKT-ABC234', status: 'approved', customer_email: 'ada@example.com', ...over });

/** The guard only has to run the function (the real one adds a Redis deadline). */
const guard = { guarded: async (fn: (expired: () => boolean) => Promise<unknown>) => fn(() => false) };

function setup(enabled = true) {
  const deliveries = new MemoryDeliveries();
  const queue = new FakeReplyQueue();
  const service = new ReplyDeliveryService(new ConfigService({ MAIL_ENABLED: enabled }) as never, deliveries as never, queue as never, guard as never);
  return { deliveries, queue, service };
}

describe('the trigger: ReplyDeliveryService.onApproved', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it.each(['approved', 'edited'])('a %s ticket with an email: a queued row and ONE job whose id is the ticket id (no email or text in either)', async (status) => {
    expect(await t.service.onApproved(ticket({ status }))).toBe('queued');
    expect(t.deliveries.rows.get(ID)).toMatchObject({ status: 'queued', reference: 'TKT-ABC234', attempts: 0 });
    expect(t.queue.adds).toEqual([{ name: 'send', jobId: ID }]);
    expect(t.queue.jobs.get(ID)?.data).toEqual({ ticket_id: ID, reference: 'TKT-ABC234' });
    expect(JSON.stringify([...t.deliveries.rows.values()])).not.toContain('ada@example.com');
  });

  it.each(['rejected', 'pending_review', 'triaged'])('a %s ticket is never emailed: no row, no job (the human-approval rule)', async (status) => {
    expect(await t.service.onApproved(ticket({ status }))).toBe('ignored');
    expect(t.deliveries.rows.size).toBe(0);
    expect(t.queue.adds).toEqual([]);
  });

  it.each([null, '', '   '])('an approved ticket with no email (%j): a skipped_no_email row and no job', async (email) => {
    expect(await t.service.onApproved(ticket({ customer_email: email }))).toBe('skipped_no_email');
    expect(t.deliveries.rows.get(ID)?.status).toBe('skipped_no_email');
    expect(t.queue.adds).toEqual([]);
  });

  it('a second review/sweep of the same ticket makes no second row and no second job', async () => {
    await t.service.onApproved(ticket());
    expect(await t.service.onApproved(ticket())).toBe('exists');
    expect(await t.service.onApproved(ticket({ status: 'edited' }))).toBe('exists');
    expect(t.deliveries.rows.size).toBe(1);
    expect(t.queue.adds).toHaveLength(1);
  });

  it('with mail switched off nothing is recorded or queued', async () => {
    const off = setup(false);
    expect(await off.service.onApproved(ticket())).toBe('disabled');
    expect(off.deliveries.rows.size).toBe(0);
    expect(off.queue.adds).toEqual([]);
  });

  it('if the job cannot be queued the row is taken back (so the sweep can make it) and the error is thrown', async () => {
    t.queue.addError = new Error('redis down');
    await expect(t.service.onApproved(ticket())).rejects.toThrow('redis down');
    expect(t.deliveries.rows.size).toBe(0);
    t.queue.addError = undefined;
    expect(await t.service.onApproved(ticket())).toBe('queued'); // what the sweep does next
  });

  it('a database failure is thrown too (the review route logs it)', async () => {
    t.deliveries.down = true;
    await expect(t.service.onApproved(ticket())).rejects.toThrow();
    expect(t.queue.adds).toEqual([]);
  });
});

describe('retry', () => {
  it('failed -> queued with zero attempts, the old finished job removed and ONE new job added', async () => {
    const t = setup();
    await t.service.onApproved(ticket());
    Object.assign(t.deliveries.rows.get(ID)!, { status: 'failed', attempts: 8, last_error: 'mail server unreachable' });

    expect(await t.service.retry(ID)).toBe(true);

    expect(t.deliveries.rows.get(ID)).toMatchObject({ status: 'queued', attempts: 0, last_error: null });
    expect(t.queue.adds).toEqual([{ name: 'send', jobId: ID }, { name: 'send', jobId: ID }]);
    expect(t.queue.jobs.has(ID)).toBe(true); // the NEW job is there (the old one was removed first, or add would have been ignored)
  });

  it.each(['queued', 'sent', 'skipped_no_email'] as const)('a %s delivery cannot be retried', async (status) => {
    const t = setup();
    await t.service.onApproved(ticket());
    t.deliveries.rows.get(ID)!.status = status;
    expect(await t.service.retry(ID)).toBe(false);
    expect(t.queue.adds).toHaveLength(1);
  });

  it('an unknown ticket cannot be retried', async () => {
    expect(await setup().service.retry(ID)).toBe(false);
  });

  it('an old job that cannot be removed (still running) means no retry', async () => {
    const t = setup();
    await t.service.onApproved(ticket());
    t.deliveries.rows.get(ID)!.status = 'failed';
    t.queue.removeError = new Error('locked');
    expect(await t.service.retry(ID)).toBe(false);
    expect(t.deliveries.rows.get(ID)?.status).toBe('failed');
  });

  it('if the new job cannot be queued the delivery goes back to failed', async () => {
    const t = setup();
    await t.service.onApproved(ticket());
    t.deliveries.rows.get(ID)!.status = 'failed';
    vi.spyOn(t.queue, 'add').mockRejectedValueOnce(new QueueUnavailableError());
    await expect(t.service.retry(ID)).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(t.deliveries.rows.get(ID)?.status).toBe('failed');
  });
});
