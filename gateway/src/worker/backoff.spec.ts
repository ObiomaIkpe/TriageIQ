import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  MAX_ATTEMPTS,
  computeBackoffMs,
  triageBackoffStrategy,
} from './backoff.js';
import { RetryableTriageError } from './triage.errors.js';

describe('computeBackoffMs', () => {
  it('constants are the agreed ones', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(BACKOFF_BASE_MS).toBe(10_000);
    expect(BACKOFF_CAP_MS).toBe(300_000);
  });

  it.each([
    [1, 10_000],
    [2, 20_000],
    [3, 40_000],
    [4, 80_000],
    [5, 160_000],
    [6, 300_000], // 320 s would be next, capped at 5 minutes
    [7, 300_000],
    [50, 300_000],
  ])('attempt %i with no Retry-After -> %i ms', (attempt, expected) => {
    expect(computeBackoffMs(attempt)).toBe(expected);
  });

  it('uses Retry-After when it is longer than the exponential delay', () => {
    expect(computeBackoffMs(1, 30)).toBe(30_000);
    expect(computeBackoffMs(2, 45)).toBe(45_000);
  });

  it('uses the exponential delay when it is longer than Retry-After', () => {
    expect(computeBackoffMs(3, 5)).toBe(40_000);
    expect(computeBackoffMs(1, 1)).toBe(10_000);
    expect(computeBackoffMs(2, 20)).toBe(20_000); // equal
  });

  it('never goes past 5 minutes, even when Retry-After asks for more', () => {
    expect(computeBackoffMs(1, 600)).toBe(300_000);
    expect(computeBackoffMs(1, 300)).toBe(300_000);
    expect(computeBackoffMs(1, 3600 * 24)).toBe(300_000);
  });

  it('ignores a Retry-After that is zero, negative or not a number', () => {
    expect(computeBackoffMs(1, 0)).toBe(10_000);
    expect(computeBackoffMs(1, -5)).toBe(10_000);
    expect(computeBackoffMs(1, Number.NaN)).toBe(10_000);
    expect(computeBackoffMs(1, Number.POSITIVE_INFINITY)).toBe(10_000);
  });

  it('treats a nonsense attempt number as attempt 1', () => {
    expect(computeBackoffMs(0)).toBe(10_000);
    expect(computeBackoffMs(-3)).toBe(10_000);
    expect(computeBackoffMs(Number.NaN)).toBe(10_000);
  });
});

describe('triageBackoffStrategy (the BullMQ custom backoff)', () => {
  it('takes Retry-After from a RetryableTriageError', () => {
    const error = new RetryableTriageError('triage service unavailable (503)', 30);
    expect(triageBackoffStrategy(1, 'custom', error)).toBe(30_000);
    expect(triageBackoffStrategy(4, 'custom', error)).toBe(80_000);
  });

  it('falls back to the exponential delay for any other error, or none', () => {
    expect(triageBackoffStrategy(2, 'custom', new Error('x'))).toBe(20_000);
    expect(triageBackoffStrategy(2, 'custom', undefined)).toBe(20_000);
    expect(triageBackoffStrategy(2, 'custom', new RetryableTriageError('timeout'))).toBe(20_000);
  });
});
