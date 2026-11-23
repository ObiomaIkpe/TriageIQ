import {
  isCountsPayload,
  isReference,
  isTicketPayload,
  isUuid,
  parseListQuery,
  parseReviewDecision,
  reviewedBySchema,
  ticketRecordSchema,
} from './passthrough.schemas.js';

describe('parseListQuery', () => {
  it('no parameters -> nothing forwarded (Python applies its defaults)', () => {
    expect(parseListQuery({})).toEqual({ ok: true, params: {} });
  });

  it('forwards status and limit, and drops every other parameter', () => {
    expect(parseListQuery({ status: 'triaged', limit: '5', evil: '1', offset: '3', api_key: 'x' })).toEqual({
      ok: true,
      params: { status: 'triaged', limit: '5' },
    });
  });

  it.each(['triaged', 'pending_review', 'approved', 'edited', 'rejected'])('accepts status %s', (status) => {
    expect(parseListQuery({ status })).toEqual({ ok: true, params: { status } });
  });

  it.each(['1', '200'])('accepts limit %s', (limit) => {
    expect(parseListQuery({ limit })).toEqual({ ok: true, params: { limit } });
  });

  it.each(['0', '201', '-1', '5.5', '1e2', ' 5', 'abc', '', '99999'])('rejects limit %j', (limit) => {
    expect(parseListQuery({ limit })).toEqual({
      ok: false,
      problems: [{ field: 'limit', problem: 'must be a whole number from 1 to 200' }],
    });
  });

  it.each(['Triaged', 'done', '', 'triaged,approved'])('rejects status %j', (status) => {
    expect(parseListQuery({ status })).toMatchObject({ ok: false, problems: [{ field: 'status' }] });
  });

  it('rejects a repeated parameter, and never echoes a value', () => {
    expect(parseListQuery({ limit: ['1', '2'] }).ok).toBe(false);
    expect(JSON.stringify(parseListQuery({ status: 'SECRETVALUE', limit: 'SECRETVALUE' }))).not.toContain('SECRET');
  });
});

describe('parseListQuery cursor and isCountsPayload', () => {
  const CURSOR = '2026-11-23T10:00:00.123456+00:00|3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
  it('accepts a cursor made of a timestamp and an id, and forwards it unchanged', () => {
    expect(parseListQuery({ cursor: CURSOR })).toEqual({ ok: true, params: { cursor: CURSOR } });
    expect(parseListQuery({ cursor: '2026-11-23T10:00:00Z|3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34' }).ok).toBe(true);
  });
  it.each(['nonsense', '', '2026-11-23T10:00:00Z', 'x|y', `${CURSOR}|extra`, '<script>|3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34', 'a'.repeat(101)])('rejects %j without echoing it', (cursor) => {
    const result = parseListQuery({ cursor });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('<script>');
  });
  it('isCountsPayload wants every status as a non-negative integer and nothing else', () => {
    const good = { triaged: 0, pending_review: 5, approved: 1, edited: 2, rejected: 3 };
    expect(isCountsPayload(good)).toBe(true);
    expect(isCountsPayload({ ...good, extra: 1 })).toBe(false);
    expect(isCountsPayload({ ...good, edited: 1.5 })).toBe(false);
    expect(isCountsPayload({ ...good, edited: -1 })).toBe(false);
    expect(isCountsPayload([good])).toBe(false);
    expect(isCountsPayload(null)).toBe(false);
  });
});

describe('ids and references', () => {
  it('isUuid', () => {
    expect(isUuid('3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34')).toBe(true);
    for (const bad of ['', 'abc', '123', '../etc/passwd', '3f6b2c1e-8a4d-4b7e-9c10', 'TKT-AAAAAA']) {
      expect(isUuid(bad)).toBe(false);
    }
  });

  it.each(['TKT-AAAAAA', 'TKT-7K3M9Q', 'TKT-ZZ2345'])('accepts the reference %s', (ref) => {
    expect(isReference(ref)).toBe(true);
  });

  it.each([
    'tkt-aaaaaa', // lower case
    'TKT-AAAAA', // too short
    'TKT-AAAAAAA', // too long
    'TKT-AAAAA0', // 0 is not in the alphabet
    'TKT-AAAAAO', // nor O, 1, I or L
    'TKT-AAAAAI',
    'TKT-AAAAA1',
    'TKT-AAAAAL',
    'XXX-AAAAAA',
    'TKT-AAAAA/',
    '../TKT-AAAAAA',
    '',
  ])('rejects the reference %j', (ref) => {
    expect(isReference(ref)).toBe(false);
  });
});

describe('parseReviewDecision', () => {
  it('approve and reject need nothing else; the note is optional', () => {
    expect(parseReviewDecision({ action: 'approve' })).toEqual({ ok: true, data: { action: 'approve' } });
    expect(parseReviewDecision({ action: 'reject', note: 'spam' })).toEqual({
      ok: true,
      data: { action: 'reject', note: 'spam' },
    });
  });

  it('edit needs a non-blank edited_reply', () => {
    expect(parseReviewDecision({ action: 'edit', edited_reply: 'Hello' })).toEqual({
      ok: true,
      data: { action: 'edit', edited_reply: 'Hello' },
    });
    for (const body of [{ action: 'edit' }, { action: 'edit', edited_reply: '   ' }, { action: 'edit', edited_reply: null }]) {
      expect(parseReviewDecision(body)).toEqual({
        ok: false,
        problems: [{ field: 'edited_reply', problem: 'is required and must not be blank for action "edit"' }],
      });
    }
  });

  it('null for the optional fields is accepted and dropped (as Python accepts it)', () => {
    expect(parseReviewDecision({ action: 'approve', edited_reply: null, note: null })).toEqual({
      ok: true,
      data: { action: 'approve' },
    });
  });

  it('keeps an edited reply exactly as given (no trimming)', () => {
    expect(parseReviewDecision({ action: 'edit', edited_reply: '  Hi \n' })).toEqual({
      ok: true,
      data: { action: 'edit', edited_reply: '  Hi \n' },
    });
  });

  it.each([
    [{ action: 'delete' }, 'action'],
    [{}, 'action'],
    [{ action: 5 }, 'action'],
    [{ action: 'approve', note: 5 }, 'note'],
    [{ action: 'edit', edited_reply: 5 }, 'edited_reply'],
  ])('rejects %j (field %s)', (body, field) => {
    expect(parseReviewDecision(body)).toMatchObject({ ok: false, problems: [{ field }] });
  });

  it('rejects unknown fields and non-objects, without echoing values', () => {
    expect(parseReviewDecision({ action: 'approve', ticket_id: 'x' })).toEqual({
      ok: false,
      problems: [{ field: 'ticket_id', problem: 'unknown field' }],
    });
    for (const body of [null, 'approve', [], 5]) {
      expect(parseReviewDecision(body).ok).toBe(false);
    }
    expect(JSON.stringify(parseReviewDecision({ action: 'SECRETVALUE', note: 'SECRETNOTE' }))).not.toContain('SECRET');
  });
});

describe('a client cannot send its own reviewer', () => {
  it.each([
    [{ action: 'approve', reviewer: { id: 'client:ops', name: 'ops' } }, 'reviewer'],
    [{ action: 'approve', reviewer: null }, 'reviewer'],
    [{ action: 'approve', reviewer: 'x' }, 'reviewer'],
    [{ action: 'approve', reviewed_by: { id: 'client:ops', name: 'ops' } }, 'reviewed_by'],
  ])('%j is refused as an unknown field', (body, field) => {
    expect(parseReviewDecision(body)).toEqual({ ok: false, problems: [{ field, problem: 'unknown field' }] });
  });

  it('the parsed decision never contains a reviewer', () => {
    const parsed = parseReviewDecision({ action: 'edit', edited_reply: 'hi', note: 'n' });
    expect(parsed.ok && 'reviewer' in parsed.data).toBe(false);
  });
});

describe('reviewed_by in Python responses', () => {
  it('reviewedBySchema takes an id and a name', () => {
    expect(reviewedBySchema.safeParse({ id: 'user:3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34', name: 'Ọbiọma Ụzọ' }).success).toBe(true);
    expect(reviewedBySchema.safeParse({ id: 'client:ops', name: 'ops', extra: 1 }).success).toBe(true); // forward compatible
    for (const bad of [null, {}, { id: 'a' }, { name: 'a' }, { id: '', name: 'a' }, { id: 'a', name: '' }, { id: 1, name: 'a' }, 'x']) {
      expect(reviewedBySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('a ticket record validates with reviewed_by as an object, as null, or absent', () => {
    for (const record of [{ reviewed_by: { id: 'client:ops', name: 'ops' } }, { reviewed_by: null }, {}, { subject: 's', reviewed_by: null }]) {
      expect(ticketRecordSchema.safeParse(record).success).toBe(true);
    }
  });

  it('every other field passes through untouched (only reviewed_by is checked)', () => {
    const parsed = ticketRecordSchema.parse({ anything: [1, 2], nested: { a: 1 }, reviewed_by: null });
    expect(parsed).toEqual({ anything: [1, 2], nested: { a: 1 }, reviewed_by: null });
  });

  it('isTicketPayload accepts a record or a list of records, and refuses a bad reviewed_by anywhere', () => {
    expect(isTicketPayload({ reviewed_by: null })).toBe(true);
    expect(isTicketPayload([{ reviewed_by: null }, { reviewed_by: { id: 'a', name: 'b' } }, {}])).toBe(true);
    expect(isTicketPayload([])).toBe(true);
    expect(isTicketPayload({ reviewed_by: 'nope' })).toBe(false);
    expect(isTicketPayload([{ reviewed_by: null }, { reviewed_by: { id: 'a' } }])).toBe(false);
    expect(isTicketPayload('a string')).toBe(false);
    expect(isTicketPayload(null)).toBe(false);
  });
});
