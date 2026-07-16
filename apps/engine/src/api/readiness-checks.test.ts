import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENGINE_READINESS_POLICY,
  createEngineReadinessChecks,
} from './readiness-checks.js';
import {
  READINESS_TEST_NOW,
  evaluateReadinessPorts,
  healthyReadinessPorts,
} from './readiness-checks.fixture.js';
import { ENGINE_READINESS_REASONS } from './readiness.js';

describe('engine readiness checks', () => {
  it('reports a fully healthy dependency set as ready', async () => {
    expect(await evaluateReadinessPorts(healthyReadinessPorts())).toEqual({
      status: 'ready',
      reasons: [],
    });
  });

  it('fails the engine readiness composite when escrow intake is not ready', async () => {
    const result = await evaluateReadinessPorts({
      ...healthyReadinessPorts(),
      escrow: { check: async () => false },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.escrowRuntimeUnavailable],
    });
  });

  it('exposes stable unavailable and timeout reasons for every injected check port', () => {
    const checks = createEngineReadinessChecks(
      healthyReadinessPorts(),
      DEFAULT_ENGINE_READINESS_POLICY,
      () => READINESS_TEST_NOW,
    );

    expect(
      checks.map(({ name, unavailableReason, timeoutReason }) => ({
        name,
        unavailableReason,
        timeoutReason,
      })),
    ).toEqual([
      {
        name: 'database',
        unavailableReason: 'database_unavailable',
        timeoutReason: 'database_timeout',
      },
      {
        name: 'feed',
        unavailableReason: 'feed_unavailable',
        timeoutReason: 'feed_timeout',
      },
      {
        name: 'wager',
        unavailableReason: 'wager_unavailable',
        timeoutReason: 'wager_timeout',
      },
      {
        name: 'telegram',
        unavailableReason: 'telegram_worker_unavailable',
        timeoutReason: 'telegram_worker_timeout',
      },
      {
        name: 'proof',
        unavailableReason: 'proof_worker_unavailable',
        timeoutReason: 'proof_worker_timeout',
      },
      {
        name: 'settlement',
        unavailableReason: 'settlement_worker_unavailable',
        timeoutReason: 'settlement_worker_timeout',
      },
    ]);
  });

  it('maps a database probe rejection to database_unavailable', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      database: {
        probe: async () => {
          throw new Error('raw database failure');
        },
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.databaseUnavailable],
    });
  });

  it('reports feed_stale when active pricing data exceeds the age budget', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      feed: {
        snapshot: async () => ({
          activePricingExpected: true,
          lastEventAtMs:
            READINESS_TEST_NOW - DEFAULT_ENGINE_READINESS_POLICY.feedMaxAgeMs - 1,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.feedStale],
    });
  });

  it('reports an inactive feed capability without failing readiness', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      feed: {
        snapshot: async () => ({ activePricingExpected: false, lastEventAtMs: null }),
      },
    });

    expect(result).toEqual({
      status: 'ready',
      reasons: [ENGINE_READINESS_REASONS.feedInactive],
    });
  });

  it('reports feed_unavailable when active pricing has no feed timestamp', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      feed: {
        snapshot: async () => ({ activePricingExpected: true, lastEventAtMs: null }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.feedUnavailable],
    });
  });

  it('reports a disabled wager capability without failing readiness', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      wager: {
        snapshot: async () => ({
          enabled: false,
          configured: false,
          runtimeMatches: true,
          paused: false,
          covered: false,
          starterIntakeReady: false,
        }),
      },
    });

    expect(result).toEqual({
      status: 'ready',
      reasons: [ENGINE_READINESS_REASONS.wagerDisabled],
    });
  });

  it('fails readiness when wager is enabled but unconfigured', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      wager: {
        snapshot: async () => ({
          enabled: true,
          configured: false,
          runtimeMatches: false,
          paused: false,
          covered: false,
          starterIntakeReady: false,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.wagerUnavailable],
    });
  });

  it('fails readiness with wager_paused when the configured desk is paused', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      wager: {
        snapshot: async () => ({
          enabled: true,
          configured: true,
          runtimeMatches: true,
          paused: true,
          covered: true,
          starterIntakeReady: true,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.wagerPaused],
    });
  });

  it('prioritizes solvency_uncovered when an uncovered desk is also paused', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      wager: {
        snapshot: async () => ({
          enabled: true,
          configured: true,
          runtimeMatches: true,
          paused: true,
          covered: false,
          starterIntakeReady: true,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.solvencyUncovered],
    });
  });

  it('reports telegram_worker_unavailable when no worker heartbeat exists', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      telegram: { snapshot: async () => ({ heartbeatAtMs: null }) },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.telegramWorkerUnavailable],
    });
  });

  it('reports telegram_worker_stale when its heartbeat exceeds the age budget', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      telegram: {
        snapshot: async () => ({
          heartbeatAtMs:
            READINESS_TEST_NOW - DEFAULT_ENGINE_READINESS_POLICY.ingressMaxAgeMs - 1,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.telegramWorkerStale],
    });
  });

});
