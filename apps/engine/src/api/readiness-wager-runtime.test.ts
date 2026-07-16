import { describe, expect, it } from 'vitest';
import { evaluateReadinessPorts, healthyReadinessPorts } from './readiness-checks.fixture.js';
import { ENGINE_READINESS_REASONS } from './readiness.js';

describe('wager runtime readiness', () => {
  it('fails when the requested and constructed wager runtimes differ', async () => {
    // Given a nominally configured snapshot whose discriminants disagree
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      wager: {
        snapshot: async () => ({
          enabled: true,
          configured: true,
          runtimeMatches: false,
          paused: false,
          covered: true,
          starterIntakeReady: true,
        }),
      },
    });

    // Then readiness blocks promotion on the existing unavailable reason
    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.wagerUnavailable],
    });
  });

  it('fails when starter intake or authoritative budget is unavailable', async () => {
    // Given a matching starter runtime whose intake composite is not ready
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      wager: {
        snapshot: async () => ({
          enabled: true,
          configured: true,
          runtimeMatches: true,
          paused: false,
          covered: true,
          starterIntakeReady: false,
        }),
      },
    });

    // Then promotion fails with a bounded starter-specific reason
    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.starterIntakeUnavailable],
    });
  });
});
