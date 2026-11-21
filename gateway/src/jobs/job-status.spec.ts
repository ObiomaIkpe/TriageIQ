import { mapJobState, shortReason } from './job-status.js';

describe('mapJobState', () => {
  it.each([
    ['waiting', 'queued'],
    ['delayed', 'queued'],
    ['prioritized', 'queued'],
    ['waiting-children', 'queued'],
    ['active', 'running'],
    ['completed', 'done'],
    ['failed', 'failed'],
  ])('%s -> %s', (state, status) => {
    expect(mapJobState(state)).toBe(status);
  });

  it.each(['unknown', 'paused', '', 'toString', '__proto__'])(
    '%s is not mapped (undefined)',
    (state) => {
      expect(mapJobState(state)).toBeUndefined();
    },
  );
});

describe('shortReason', () => {
  it('keeps only the first line, never a stack trace', () => {
    expect(shortReason('Python service returned 500\n    at Worker.run (/app/x.js:1:1)')).toBe(
      'Python service returned 500',
    );
  });

  it('cuts a very long reason', () => {
    const reason = shortReason('x'.repeat(1000));
    expect(reason.length).toBeLessThanOrEqual(203);
    expect(reason.endsWith('...')).toBe(true);
  });

  it('has a fallback when there is no reason', () => {
    expect(shortReason(undefined)).toBe('Job failed');
    expect(shortReason('  \n  ')).toBe('Job failed');
  });
});
