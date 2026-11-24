import { Logger } from '@nestjs/common';
import { afterEach, beforeAll, vi } from 'vitest';
import { stubEnv } from './app-helpers.js';
import { TEST_ORIGIN, bearer } from './auth-helpers.js';
import { EMAIL, PASSWORD, cookieOf, login, recordingPython, startLoginApp, withCookie, type LoginApp } from './login-helpers.js';

/**
 * Who a review is recorded as: the gateway builds `reviewer` from the AUTHENTICATED principal and
 * sends it to Python in the body. Python is a fake that records every call.
 */
const TICKET_ID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const URL = `/tickets/${TICKET_ID}/review`;
const RECORD = { ticket_id: TICKET_ID, reference: 'TKT-AAAAAA', status: 'edited' };

describe('reviewer recording through the gateway (fake Python)', () => {
  let world: LoginApp;
  let python: ReturnType<typeof recordingPython>;
  let answer: { status: number; body: unknown };

  beforeAll(() => stubEnv());
  afterEach(async () => {
    vi.restoreAllMocks();
    await world?.app.close();
  });

  async function start() {
    answer = { status: 200, body: { ...RECORD, reviewed_by: null } };
    python = recordingPython(() => answer);
    world = await startLoginApp(python.fetchFn);
  }
  const reviewCalls = () => python.calls.filter((c) => c.url.includes('/review'));

  describe('who the reviewer is', () => {
    it('a logged-in reviewer (cookie): {id: "user:<uuid>", name: <display_name>}', async () => {
      await start();
      const cookie = cookieOf(await login(world).expect(200)) as string;
      answer = { status: 200, body: { ...RECORD, reviewed_by: { id: `user:${world.ada.id}`, name: 'Ada Lovelace' } } };

      const response = await withCookie(world, cookie).post(URL).send({ action: 'edit', edited_reply: 'A human wrote this.' }).expect(200);

      expect(reviewCalls()).toHaveLength(1);
      expect(reviewCalls()[0].body).toEqual({
        action: 'edit',
        edited_reply: 'A human wrote this.',
        reviewer: { id: `user:${world.ada.id}`, name: 'Ada Lovelace' },
      });
      expect(response.body.reviewed_by).toEqual({ id: `user:${world.ada.id}`, name: 'Ada Lovelace' });
    });

    it('a reviewer API key (client "ops"): {id: "client:ops", name: "ops"}', async () => {
      await start();
      await world.http().post(URL).set('Authorization', bearer('ops')).send({ action: 'approve' }).expect(200);
      expect(reviewCalls()[0].body).toEqual({ action: 'approve', reviewer: { id: 'client:ops', name: 'ops' } });
    });

    it('the name is the display name at THIS login: after a rename, the next review carries the new name', async () => {
      await start();
      const cookie = cookieOf(await login(world).expect(200)) as string;
      await withCookie(world, cookie).post(URL).send({ action: 'approve' }).expect(200);
      world.users.rows.get(world.ada.id)!.displayName = 'Ada King';
      await withCookie(world, cookie).post(URL).send({ action: 'approve' }).expect(200);
      expect(reviewCalls().map((c) => (c.body as { reviewer: { name: string } }).reviewer.name)).toEqual(['Ada Lovelace', 'Ada King']);
    });

    it('a Unicode display name is sent intact in the JSON body (no header is involved)', async () => {
      await start();
      world.users.rows.get(world.ada.id)!.displayName = 'Ọbiọma Ụzọ';
      const cookie = cookieOf(await login(world).expect(200)) as string;
      await withCookie(world, cookie).post(URL).send({ action: 'approve' }).expect(200);
      const sent = reviewCalls()[0];
      expect((sent.body as { reviewer: { name: string } }).reviewer.name).toBe('Ọbiọma Ụzọ');
      // and the name travels in the body only: no header carries it
      expect(JSON.stringify(sent.headers)).not.toContain('Ọbiọma');
      expect(Object.keys(sent.headers).sort((a, b) => a.localeCompare(b))).toEqual(['accept', 'content-type', 'x-api-key']);
    });

    it('a submitter key cannot review at all (403), so Python is never asked', async () => {
      await start();
      await world.http().post(URL).set('Authorization', bearer('alice')).send({ action: 'approve' }).expect(403);
      expect(python.calls).toHaveLength(0);
    });
  });

  describe('a client can never choose the reviewer', () => {
    it.each([
      [{ action: 'approve', reviewer: { id: 'user:00000000-0000-4000-8000-000000000001', name: 'Someone Else' } }],
      [{ action: 'approve', reviewer: 'client:ops' }],
      [{ action: 'approve', reviewer: null }],
      [{ action: 'approve', reviewer: {} }],
      [{ action: 'approve', reviewed_by: { id: 'client:ops', name: 'ops' } }],
    ])('a body carrying its own reviewer field %j -> 400, and Python is never called', async (body) => {
      await start();
      const cookie = cookieOf(await login(world).expect(200)) as string;
      const byCookie = await withCookie(world, cookie).post(URL).send(body).expect(400);
      const byKey = await world.http().post(URL).set('Authorization', bearer('ops')).send(body).expect(400);

      for (const response of [byCookie, byKey]) {
        expect(response.body.detail).toBe('Invalid review decision');
        expect(response.body.errors).toEqual([{ field: Object.keys(body).find((k) => k !== 'action'), problem: 'unknown field' }]);
        expect(JSON.stringify(response.body)).not.toContain('Someone Else'); // nothing typed is echoed
      }
      expect(python.calls).toHaveLength(0);
    });

    it('the reviewer Python receives is the principal\'s even if the client also sent other fields', async () => {
      await start();
      await world.http().post(URL).set('Authorization', bearer('ops')).send({ action: 'approve', note: 'n' }).expect(200);
      expect((reviewCalls()[0].body as { reviewer: unknown }).reviewer).toEqual({ id: 'client:ops', name: 'ops' });
    });
  });

  describe('Python responses are checked for reviewed_by', () => {
    it.each([
      ['an object', { id: 'user:3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34', name: 'Ada Lovelace' }],
      ['null (not reviewed, or reviewed before it was recorded)', null],
    ])('a ticket read with reviewed_by as %s passes through unchanged', async (_label, reviewedBy) => {
      await start();
      answer = { status: 200, body: { ...RECORD, reviewed_by: reviewedBy } };
      const response = await world.http().get(`/tickets/${TICKET_ID}`).set('Authorization', bearer('ops')).expect(200);
      expect(response.body).toEqual({ ...RECORD, reviewed_by: reviewedBy });
    });

    it('a response WITHOUT reviewed_by (an older Python) still passes', async () => {
      await start();
      answer = { status: 200, body: RECORD };
      await world.http().get(`/tickets/${TICKET_ID}`).set('Authorization', bearer('ops')).expect(200);
    });

    it('a list mixing reviewed and unreviewed tickets passes', async () => {
      await start();
      answer = { status: 200, body: [{ ...RECORD, reviewed_by: { id: 'client:ops', name: 'ops' } }, { ...RECORD, reviewed_by: null }, RECORD] };
      const response = await world.http().get('/tickets').set('Authorization', bearer('ops')).expect(200);
      expect(response.body).toHaveLength(3);
    });

    it.each([
      ['a string', 'client:ops'],
      ['an object without a name', { id: 'client:ops' }],
      ['an object with an empty id', { id: '', name: 'ops' }],
      ['an object whose name is a number', { id: 'client:ops', name: 5 }],
      ['an array', []],
    ])('a malformed reviewed_by (%s) is a 502 "Triage service error", never passed on', async (_label, reviewedBy) => {
      await start();
      answer = { status: 200, body: { ...RECORD, reviewed_by: reviewedBy } };
      const response = await world.http().get(`/tickets/${TICKET_ID}`).set('Authorization', bearer('ops')).expect(502);
      expect(response.body).toEqual({ detail: 'Triage service error' });
    });

    it('a malformed reviewed_by inside a list is a 502 too, and the review answer is checked as well', async () => {
      await start();
      answer = { status: 200, body: [RECORD, { ...RECORD, reviewed_by: 'nope' }] };
      await world.http().get('/tickets').set('Authorization', bearer('ops')).expect(502);
      answer = { status: 200, body: { ...RECORD, reviewed_by: { id: 'client:ops' } } };
      await world.http().post(URL).set('Authorization', bearer('ops')).send({ action: 'approve' }).expect(502);
    });

    it('error answers (404, 409, 422) pass through whatever they hold: only successful ticket answers are checked', async () => {
      await start();
      for (const [status, body] of [[404, { detail: 'Ticket not found' }], [409, { detail: 'Ticket is not waiting for a review' }], [422, { detail: [{ msg: 'x' }] }]] as const) {
        answer = { status, body };
        const response = await world.http().post(URL).set('Authorization', bearer('ops')).send({ action: 'approve' });
        expect(response.status).toBe(status);
        expect(response.body).toEqual(body);
      }
    });
  });

  describe('the passthrough log line', () => {
    function captureLogs() {
      const lines: string[] = [];
      for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        vi.spyOn(Logger.prototype, method).mockImplementation((m: unknown) => void lines.push(String(m)));
      }
      return lines;
    }

    it('a review by a logged-in reviewer logs the namespaced id, and never the name or the email', async () => {
      await start();
      const cookie = cookieOf(await login(world).expect(200)) as string;
      const lines = captureLogs();
      await withCookie(world, cookie).post(URL).send({ action: 'approve' }).expect(200);

      const line = lines.find((l) => l.includes('route="POST /tickets/:id/review"')) as string;
      expect(line).toMatch(new RegExp(`^client=user:${world.ada.id} route="POST /tickets/:id/review" reviewer=user:${world.ada.id} python_status=200 duration_ms=\\d+$`));
      const everything = lines.join('\n');
      expect(everything).not.toContain('Ada Lovelace');
      expect(everything).not.toContain(EMAIL);
      expect(everything).not.toContain(PASSWORD);
    });

    it('a review by a client logs "reviewer=client:<name>"', async () => {
      await start();
      const lines = captureLogs();
      await world.http().post(URL).set('Authorization', bearer('ops')).send({ action: 'approve' }).expect(200);
      expect(lines.find((l) => l.includes('/review'))).toMatch(/^client=ops route="POST \/tickets\/:id\/review" reviewer=client:ops python_status=200 duration_ms=\d+$/);
    });

    it('reads have no reviewer field (nothing is being decided)', async () => {
      await start();
      const lines = captureLogs();
      await world.http().get('/tickets').set('Authorization', bearer('ops')).expect(200);
      expect(lines.find((l) => l.includes('route="GET /tickets"'))).not.toContain('reviewer=');
    });
  });

  it('API-key reviews still need no Origin, and a cookie review still does', async () => {
    await start();
    const cookie = cookieOf(await login(world).expect(200)) as string;
    await world.http().post(URL).set('Authorization', bearer('ops')).send({ action: 'approve' }).expect(200);
    await world.http().post(URL).set('Cookie', cookie).send({ action: 'approve' }).expect(403);
    await world.http().post(URL).set('Cookie', cookie).set('Origin', TEST_ORIGIN).send({ action: 'approve' }).expect(200);
  });
});
