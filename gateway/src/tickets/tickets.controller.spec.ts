import { HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { vi } from 'vitest';
import { FakeQueue } from '../../test/fake-queue.js';
import { TriageQueueService, type QueueLike } from '../queue/triage-queue.service.js';
import { clientPrincipal } from '../auth/principal.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { ReferenceUnavailableError } from './reference.service.js';
import { INTAKE_UNAVAILABLE, TicketsController } from './tickets.controller.js';

const TIMEOUT_MS = 40;
const ALICE = clientPrincipal('alice', 'submitter');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Reserves whatever it is asked to (the database is not involved in these tests). */
const reserveAnything = { reserve: async (first?: string) => first as string } as never;

function setup(queue: FakeQueue, references: unknown = reserveAnything) {
  const service = new TriageQueueService(queue as QueueLike, TIMEOUT_MS);
  const controller = new TicketsController(service, new IdempotencyService(service, queue.kv), references as never);
  const setHeader = vi.fn();
  const response = { setHeader } as unknown as Response;
  return { controller, setHeader, response };
}

async function failure(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected the call to fail');
}

describe('TicketsController.create', () => {
  it('queues the ticket and returns the 202 body and a Location header', async () => {
    const queue = new FakeQueue();
    const { controller, setHeader, response } = setup(queue);

    const result = await controller.create({ subject: ' Hi ', body: 'Help', customer_id: 'c1' }, response, undefined, ALICE);

    expect(result).toEqual({
      job_id: expect.stringMatching(UUID),
      reference: expect.stringMatching(/^TKT-[A-HJKMNP-Z2-9]{6}$/),
      status: 'queued',
      status_url: `/jobs/${result.job_id}`,
    });
    expect(setHeader).toHaveBeenCalledWith('Location', `/jobs/${result.job_id}`);
  });

  it('stores subject, body, customer_id and received_at under the generated job id', async () => {
    const queue = new FakeQueue();
    const { controller, response } = setup(queue);

    const before = Date.now();
    const result = await controller.create({ subject: ' Hi ', body: 'Help', customer_id: 'c1' }, response, undefined, ALICE);

    expect(queue.added).toHaveLength(1);
    const [added] = queue.added;
    expect(added.name).toBe('triage');
    expect(added.jobId).toBe(result.job_id);
    expect(added.data).toEqual({
      subject: 'Hi',
      body: 'Help',
      customer_id: 'c1',
      client: 'alice',
      reference: result.reference,
      received_at: expect.any(String),
    });
    const receivedAt = new Date(added.data.received_at).getTime();
    expect(new Date(added.data.received_at).toISOString()).toBe(added.data.received_at);
    expect(receivedAt).toBeGreaterThanOrEqual(before);
    expect(receivedAt).toBeLessThanOrEqual(Date.now());
  });

  it('gives every ticket its own job id', async () => {
    const { controller, response } = setup(new FakeQueue());
    const a = await controller.create({ subject: 'a', body: 'b' }, response, undefined, ALICE);
    const b = await controller.create({ subject: 'a', body: 'b' }, response, undefined, ALICE);
    expect(a.job_id).not.toBe(b.job_id);
  });

  it('invalid input -> 400 with a field/problem list, and nothing is queued', async () => {
    const queue = new FakeQueue();
    const { controller, response } = setup(queue);

    const error = await failure(controller.create({ subject: '', body: 'ok' }, response, undefined, ALICE));

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      detail: 'Invalid ticket',
      errors: [{ field: 'subject', problem: 'must not be empty' }],
    });
    expect(queue.added).toHaveLength(0);
  });

  it('queue failure -> 503, no Location header, nothing claimed as queued', async () => {
    const queue = new FakeQueue();
    queue.mode = 'fail';
    const { controller, setHeader, response } = setup(queue);

    const error = await failure(controller.create({ subject: 'a', body: 'b' }, response, undefined, ALICE));

    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({ detail: INTAKE_UNAVAILABLE });
    expect(setHeader).not.toHaveBeenCalled();
    expect(JSON.stringify(error.getResponse())).not.toMatch(/10\.9\.9\.9|ECONNREFUSED/);
  });

  it('queue hang -> 503 within the timeout', async () => {
    const queue = new FakeQueue();
    queue.mode = 'hang';
    const { controller, setHeader, response } = setup(queue);

    const started = Date.now();
    const error = await failure(controller.create({ subject: 'a', body: 'b' }, response, undefined, ALICE));
    const took = Date.now() - started;

    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({ detail: INTAKE_UNAVAILABLE });
    expect(took).toBeGreaterThanOrEqual(TIMEOUT_MS - 5);
    expect(took).toBeLessThan(TIMEOUT_MS * 5);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('connection not up yet -> 503, and the ticket is NOT stored when the connection comes up later', async () => {
    const queue = new FakeQueue();
    queue.mode = 'not-ready';
    const { controller, setHeader, response } = setup(queue);

    const error = await failure(controller.create({ subject: 'a', body: 'b' }, response, undefined, ALICE));
    expect(error.getStatus()).toBe(503);

    // Redis comes back after the client was already told 503.
    queue.becomeReady();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queue.added).toHaveLength(0);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('waits for the connection before sending the write', async () => {
    const queue = new FakeQueue();
    queue.mode = 'not-ready';
    const { controller, response } = setup(queue);

    const pending = controller.create({ subject: 'a', body: 'b' }, response, undefined, ALICE);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(queue.added).toHaveLength(0); // still waiting, nothing sent

    queue.becomeReady(); // up before the deadline
    await expect(pending).resolves.toMatchObject({ status: 'queued' });
    expect(queue.added).toHaveLength(1);
  });
});

describe('TicketsController: reference reservation', () => {
  const calls: (string | undefined)[] = [];
  const references = { reserve: async (first?: string) => (calls.push(first), 'TKT-RESRVD'.replace('RESRVD', 'AAAAAA')) };
  beforeEach(() => { calls.length = 0; });
  const ticket = { subject: 'Hi', body: 'Help' };

  it('without a key: reserves once, and the reserved reference is the one queued and returned', async () => {
    const queue = new FakeQueue();
    const { controller, response } = setup(queue, references);
    const result = await controller.create(ticket, response, undefined, ALICE);
    expect(calls).toHaveLength(1);
    expect(result.reference).toBe('TKT-AAAAAA');
    expect(queue.added[0].data.reference).toBe('TKT-AAAAAA');
  });

  it('with a key: a new key reserves once and the key remembers the RESERVED reference (not the first candidate)', async () => {
    const queue = new FakeQueue();
    const { controller, response } = setup(queue, references);
    const first = await controller.create(ticket, response, 'k1', ALICE);
    expect(first.reference).toBe('TKT-AAAAAA');
    expect(calls).toHaveLength(1);
    expect(JSON.parse([...queue.kv.entries.values()][0].value).reference).toBe('TKT-AAAAAA');
  });

  it('a replay of the same key reserves nothing and returns the same reference', async () => {
    const queue = new FakeQueue();
    const { controller, response } = setup(queue, references);
    const first = await controller.create(ticket, response, 'k1', ALICE);
    const again = await controller.create(ticket, response, 'k1', ALICE);
    expect(calls).toHaveLength(1);
    expect(again.reference).toBe(first.reference);
    expect(queue.added).toHaveLength(1);
  });

  it('a conflicting reuse of the key (different ticket) reserves nothing', async () => {
    const queue = new FakeQueue();
    const { controller, response } = setup(queue, references);
    await controller.create(ticket, response, 'k1', ALICE);
    await failure(controller.create({ subject: 'Other', body: 'x' }, response, 'k1', ALICE));
    expect(calls).toHaveLength(1);
  });

  it('when no reference can be reserved: 503, nothing queued, and the key is released so a retry works', async () => {
    const queue = new FakeQueue();
    let fail = true;
    const flaky = { reserve: async (first?: string) => { if (fail) throw new ReferenceUnavailableError(); return first as string; } };
    const { controller, response } = setup(queue, flaky);
    const error = await failure(controller.create(ticket, response, 'k1', ALICE));
    expect(error.getStatus()).toBe(503);
    expect(queue.added).toHaveLength(0);
    expect(queue.kv.entries.size).toBe(0);
    fail = false;
    expect((await controller.create(ticket, response, 'k1', ALICE)).reference).toMatch(/^TKT-/);
  });

  it('without a key the same failure is a 503 too', async () => {
    const queue = new FakeQueue();
    const { controller, response } = setup(queue, { reserve: async () => { throw new ReferenceUnavailableError(); } });
    expect((await failure(controller.create(ticket, response, undefined, ALICE))).getStatus()).toBe(503);
    expect(queue.added).toHaveLength(0);
  });

  it('when the first candidate was taken, the key is updated to the reference that was really reserved', async () => {
    const queue = new FakeQueue();
    const taken = { reserve: async () => 'TKT-ZZZZZZ' };
    const { controller, response } = setup(queue, taken);
    const result = await controller.create(ticket, response, 'k1', ALICE);
    expect(result.reference).toBe('TKT-ZZZZZZ');
    expect(JSON.parse([...queue.kv.entries.values()][0].value).reference).toBe('TKT-ZZZZZZ');
    const replay = await controller.create(ticket, response, 'k1', ALICE);
    expect(replay.reference).toBe('TKT-ZZZZZZ');
  });
});
