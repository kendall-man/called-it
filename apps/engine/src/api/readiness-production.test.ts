import { describe, expect, it } from 'vitest';
import { createProductionReadinessPorts } from './readiness-production.js';

const NOW = Date.parse('2026-07-10T00:00:00.000Z');

describe('production readiness ports', () => {
  it('reports starter-only ready only when runtime, intake, circuit, and budget agree', async () => {
    // Given matching starter runtime construction and available authoritative budget
    const calls: string[] = [];
    const ports = createProductionReadinessPorts({
      database: {
        probe: async () => undefined,
        liveFixtureIds: async () => [],
        async wagerStatus() {
          calls.push('circuit');
          return { paused: false, reason: null };
        },
        async starterBudget() {
          calls.push('budget');
          return { enabled: true, available: true };
        },
      },
      odds: { snapshot: async () => ({ kind: 'unavailable' }) },
      liveLookaheadMs: 60_000,
      now: () => NOW,
      wagerRuntimeMode: 'starter_only',
      wagerModuleKind: 'starter_only',
      starterGrantsEnabled: true,
      starterIntakeEnabled: true,
      proofEnabled: false,
      settlementEnabled: false,
    });

    // When the wager readiness snapshot is requested
    const snapshot = await ports.wager.snapshot(new AbortController().signal);

    // Then every starter-only gate is represented without a treasury dependency
    expect(snapshot).toEqual({
      enabled: true,
      configured: true,
      runtimeMatches: true,
      paused: false,
      covered: true,
      starterIntakeReady: true,
    });
    expect(calls).toEqual(['circuit', 'budget']);
  });

  it('reports a runtime mismatch without reading wager state', async () => {
    // Given starter-only was requested but a funded module was constructed
    const calls: string[] = [];
    const ports = createProductionReadinessPorts({
      database: {
        probe: async () => undefined,
        liveFixtureIds: async () => [],
        wagerStatus: async () => {
          calls.push('circuit');
          return { paused: false, reason: null };
        },
        starterBudget: async () => {
          calls.push('budget');
          return { enabled: true, available: true };
        },
      },
      odds: { snapshot: async () => ({ kind: 'unavailable' }) },
      liveLookaheadMs: 60_000,
      now: () => NOW,
      wagerRuntimeMode: 'starter_only',
      wagerModuleKind: 'funded',
      starterGrantsEnabled: true,
      starterIntakeEnabled: true,
      proofEnabled: false,
      settlementEnabled: false,
    });

    // When readiness snapshots the runtime
    const snapshot = await ports.wager.snapshot(new AbortController().signal);

    // Then construction mismatch is fail-closed before unrelated state reads
    expect(snapshot).toMatchObject({ configured: false, runtimeMatches: false });
    expect(calls).toEqual([]);
  });

  it('reports funded starter intake as unconfigured before reading wager state', async () => {
    // Given an invalid funded runtime that retained starter intake capability
    const calls: string[] = [];
    const ports = createProductionReadinessPorts({
      database: {
        probe: async () => undefined,
        liveFixtureIds: async () => [],
        wagerStatus: async () => {
          calls.push('circuit');
          return { paused: false, reason: null };
        },
        starterBudget: async () => ({ enabled: true, available: true }),
      },
      odds: { snapshot: async () => ({ kind: 'unavailable' }) },
      liveLookaheadMs: 60_000,
      now: () => NOW,
      wagerRuntimeMode: 'funded',
      wagerModuleKind: 'funded',
      starterGrantsEnabled: true,
      starterIntakeEnabled: false,
      proofEnabled: false,
      settlementEnabled: false,
    });

    // When readiness snapshots the contradictory runtime
    const snapshot = await ports.wager.snapshot(new AbortController().signal);

    // Then promotion fails before funded state can mask the invalid capability
    expect(snapshot).toEqual({
      enabled: true,
      configured: false,
      runtimeMatches: true,
      paused: false,
      covered: false,
      starterIntakeReady: false,
    });
    expect(calls).toEqual([]);
  });

  it('fails closed until the initial funded solvency pass completes successfully', async () => {
    let solvencyAttempts = 0;
    let statusReads = 0;
    const ports = createProductionReadinessPorts({
      database: {
        probe: async () => undefined,
        liveFixtureIds: async () => [],
        wagerStatus: async () => {
          statusReads += 1;
          return { paused: false, reason: null };
        },
        starterBudget: async () => ({ enabled: false, available: false }),
      },
      odds: { snapshot: async () => ({ kind: 'unavailable' }) },
      liveLookaheadMs: 60_000,
      now: () => NOW,
      wagerRuntimeMode: 'funded',
      wagerModuleKind: 'funded',
      starterGrantsEnabled: false,
      starterIntakeEnabled: false,
      proofEnabled: false,
      settlementEnabled: false,
      initialSolvencyCheck: async () => {
        solvencyAttempts += 1;
        return solvencyAttempts > 1;
      },
    });
    const signal = new AbortController().signal;

    await expect(ports.wager.snapshot(signal)).resolves.toMatchObject({
      configured: false,
      covered: false,
    });
    expect(statusReads).toBe(0);
    await expect(ports.wager.snapshot(signal)).resolves.toMatchObject({
      configured: true,
      covered: true,
    });
    expect(statusReads).toBe(1);
  });

  it('forwards one AbortSignal through database, feed, odds, and wager operations', async () => {
    const calls: Array<{ name: string; signal: AbortSignal }> = [];
    const ports = createProductionReadinessPorts({
      database: {
        async probe(signal) {
          calls.push({ name: 'database', signal });
        },
        async liveFixtureIds(_nowMs, _lookaheadMs, signal) {
          calls.push({ name: 'fixtures', signal });
          return [7];
        },
        async wagerStatus(signal) {
          calls.push({ name: 'wager', signal });
          return { paused: false, reason: null };
        },
        starterBudget: async () => ({ enabled: false, available: false }),
      },
      odds: {
        async snapshot(fixtureId, signal) {
          calls.push({ name: `odds:${fixtureId}`, signal });
          return { kind: 'ok', oddsTsMs: NOW };
        },
      },
      liveLookaheadMs: 60_000,
      now: () => NOW,
      wagerRuntimeMode: 'funded',
      wagerModuleKind: 'funded',
      starterGrantsEnabled: false,
      starterIntakeEnabled: false,
      proofEnabled: false,
      settlementEnabled: false,
    });
    const controller = new AbortController();

    await Promise.all([
      ports.database.probe(controller.signal),
      ports.feed.snapshot(controller.signal),
      ports.wager.snapshot(controller.signal),
      ports.proof.snapshot(controller.signal),
      ports.settlement.snapshot(controller.signal),
    ]);

    expect(calls.map((call) => call.name)).toEqual([
      'database',
      'fixtures',
      'wager',
      'odds:7',
    ]);
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  it('refuses static capability snapshots after cancellation', async () => {
    const ports = createProductionReadinessPorts({
      database: {
        probe: async () => undefined,
        liveFixtureIds: async () => [],
        wagerStatus: async () => ({ paused: false, reason: null }),
        starterBudget: async () => ({ enabled: false, available: false }),
      },
      odds: { snapshot: async () => ({ kind: 'unavailable' }) },
      liveLookaheadMs: 60_000,
      now: () => NOW,
      wagerRuntimeMode: 'disabled',
      wagerModuleKind: null,
      starterGrantsEnabled: false,
      starterIntakeEnabled: false,
      proofEnabled: false,
      settlementEnabled: false,
    });
    const controller = new AbortController();
    controller.abort(new Error('cancelled before snapshot'));

    await expect(ports.proof.snapshot(controller.signal)).rejects.toThrow(
      'cancelled before snapshot',
    );
    await expect(ports.settlement.snapshot(controller.signal)).rejects.toThrow(
      'cancelled before snapshot',
    );
  });

  it('uses injected durable queue snapshots instead of placeholder backlog values', async () => {
    const controller = new AbortController();
    const ports = createProductionReadinessPorts({
      database: {
        probe: async () => undefined,
        liveFixtureIds: async () => [],
        wagerStatus: async () => ({ paused: false, reason: null }),
        starterBudget: async () => ({ enabled: false, available: false }),
      },
      odds: { snapshot: async () => ({ kind: 'unavailable' }) },
      liveLookaheadMs: 60_000,
      now: () => NOW,
      wagerRuntimeMode: 'disabled',
      wagerModuleKind: null,
      starterGrantsEnabled: false,
      starterIntakeEnabled: false,
      proofEnabled: true,
      settlementEnabled: true,
      proofQueue: {
        snapshot: async (signal) => ({
          enabled: true,
          heartbeatAtMs: NOW,
          backlog: signal === controller.signal ? 7 : 0,
          oldestAgeMs: 1_000,
        }),
      },
      settlementQueue: {
        snapshot: async () => ({
          enabled: true,
          heartbeatAtMs: NOW,
          backlog: 3,
          oldestAgeMs: null,
        }),
      },
    });

    await expect(ports.proof.snapshot(controller.signal)).resolves.toEqual({
      enabled: true,
      heartbeatAtMs: NOW,
      backlog: 7,
      oldestAgeMs: 1_000,
    });
    await expect(ports.settlement.snapshot(controller.signal)).resolves.toEqual({
      enabled: true,
      heartbeatAtMs: NOW,
      backlog: 3,
      oldestAgeMs: null,
    });
  });
});
