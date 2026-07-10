import { describe, expect, it } from 'vitest';
import { createProductionReadinessPorts } from './readiness-production.js';

const NOW = Date.parse('2026-07-10T00:00:00.000Z');

describe('production readiness ports', () => {
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
      },
      odds: {
        async snapshot(fixtureId, signal) {
          calls.push({ name: `odds:${fixtureId}`, signal });
          return { kind: 'ok', oddsTsMs: NOW };
        },
      },
      liveLookaheadMs: 60_000,
      now: () => NOW,
      wagerEnabled: true,
      wagerConfigured: true,
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
      },
      odds: { snapshot: async () => ({ kind: 'unavailable' }) },
      liveLookaheadMs: 60_000,
      now: () => NOW,
      wagerEnabled: false,
      wagerConfigured: false,
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
      },
      odds: { snapshot: async () => ({ kind: 'unavailable' }) },
      liveLookaheadMs: 60_000,
      now: () => NOW,
      wagerEnabled: false,
      wagerConfigured: false,
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
