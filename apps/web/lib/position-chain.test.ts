import { describe, expect, it } from 'vitest';
import { positionMetrics } from './position-chain';

describe('position approval metrics', () => {
  it('shows the deterministic back-side maximum return and aggregate match level', () => {
    const result = positionMetrics({
      activeBackTotal: 10_000n,
      activeDoubtTotal: 15_000n,
      ratioMilli: 1_500,
    }, 'back', 10_000n);

    expect(result.lockedMultiplier).toBe('2.5x');
    expect(result.maxPossibleReturnAtomic).toBe(25_000n);
    expect(result.currentMatchedPercent).toBe(50);
  });

  it('uses the inverse ratio for doubt-side return display', () => {
    const result = positionMetrics({
      activeBackTotal: 15_000n,
      activeDoubtTotal: 0n,
      ratioMilli: 1_500,
    }, 'doubt', 15_000n);

    expect(result.lockedMultiplier).toBe('1.666x');
    expect(result.maxPossibleReturnAtomic).toBe(25_000n);
    expect(result.currentMatchedPercent).toBe(100);
  });
});
