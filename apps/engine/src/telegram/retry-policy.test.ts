import { describe, expect, it } from 'vitest';
import { computeTelegramRetryAtMs, computeTelegramRetryDelayMs } from './retry-policy.js';

describe('computeTelegramRetryDelayMs', () => {
  it('uses equal jitter across the inclusive lower and upper bound', () => {
    expect(
      computeTelegramRetryDelayMs({
        attempt: 1,
        retryBaseMs: 100,
        retryMaxMs: 1_000,
        randomValue: 0,
      }),
    ).toBe(50);
    expect(
      computeTelegramRetryDelayMs({
        attempt: 1,
        retryBaseMs: 100,
        retryMaxMs: 1_000,
        randomValue: 0.999999,
      }),
    ).toBe(100);
    expect(
      computeTelegramRetryDelayMs({
        attempt: 1,
        retryBaseMs: 100,
        retryMaxMs: 1_000,
        randomValue: 1,
      }),
    ).toBe(100);
    expect(
      computeTelegramRetryDelayMs({
        attempt: 4,
        retryBaseMs: 100,
        retryMaxMs: 1_000,
        randomValue: 0,
      }),
    ).toBe(400);
    expect(
      computeTelegramRetryDelayMs({
        attempt: 4,
        retryBaseMs: 100,
        retryMaxMs: 1_000,
        randomValue: 0.999999,
      }),
    ).toBe(800);
  });

  it('caps the exponential growth before overflow and composes retryAt from now', () => {
    const delay = computeTelegramRetryDelayMs({
      attempt: 100,
      retryBaseMs: 1_000,
      retryMaxMs: 86_400_000,
      randomValue: 0.5,
    });
    expect(delay).toBeGreaterThanOrEqual(43_200_000);
    expect(delay).toBeLessThanOrEqual(86_400_000);
    expect(
      computeTelegramRetryAtMs({
        nowMs: 10_000,
        attempt: 2,
        retryBaseMs: 100,
        retryMaxMs: 1_000,
        randomValue: 0,
      }),
    ).toBe(10_100);
  });
});
