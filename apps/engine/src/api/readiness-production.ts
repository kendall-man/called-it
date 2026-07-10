import { SOLVENCY_PAUSE_REASON_PREFIX } from '../wager/constants.js';
import type { EngineReadinessPorts } from './readiness-checks.js';

export interface ProductionReadinessDatabasePort {
  probe(signal: AbortSignal): Promise<void>;
  liveFixtureIds(
    nowMs: number,
    lookaheadMs: number,
    signal: AbortSignal,
  ): Promise<readonly number[]>;
  wagerStatus(
    signal: AbortSignal,
  ): Promise<{ readonly paused: boolean; readonly reason: string | null }>;
}

export type ProductionReadinessOddsResult =
  | { readonly kind: 'ok'; readonly oddsTsMs: number | null }
  | { readonly kind: 'unavailable' };

export interface ProductionReadinessOddsPort {
  snapshot(
    fixtureId: number,
    signal: AbortSignal,
  ): Promise<ProductionReadinessOddsResult>;
}

export interface ProductionReadinessOptions {
  readonly database: ProductionReadinessDatabasePort;
  readonly odds: ProductionReadinessOddsPort;
  readonly now: () => number;
  readonly liveLookaheadMs: number;
  readonly wagerEnabled: boolean;
  readonly wagerConfigured: boolean;
  readonly proofEnabled: boolean;
  readonly settlementEnabled: boolean;
}

function checkCancellation(signal: AbortSignal): void {
  signal.throwIfAborted();
}

export function createProductionReadinessPorts(
  options: ProductionReadinessOptions,
): Omit<EngineReadinessPorts, 'telegram'> {
  return {
    database: {
      async probe(signal) {
        checkCancellation(signal);
        await options.database.probe(signal);
        checkCancellation(signal);
      },
    },
    feed: {
      async snapshot(signal) {
        checkCancellation(signal);
        const fixtureIds = await options.database.liveFixtureIds(
          options.now(),
          options.liveLookaheadMs,
          signal,
        );
        checkCancellation(signal);
        if (fixtureIds.length === 0) {
          return { activePricingExpected: false, lastEventAtMs: null };
        }
        const results = await Promise.all(
          fixtureIds.map(async (fixtureId) => {
            checkCancellation(signal);
            const result = await options.odds.snapshot(fixtureId, signal);
            checkCancellation(signal);
            return result;
          }),
        );
        let oldestTimestamp: number | null = null;
        for (const result of results) {
          if (result.kind !== 'ok' || result.oddsTsMs === null) {
            return { activePricingExpected: true, lastEventAtMs: null };
          }
          oldestTimestamp =
            oldestTimestamp === null
              ? result.oddsTsMs
              : Math.min(oldestTimestamp, result.oddsTsMs);
        }
        checkCancellation(signal);
        return { activePricingExpected: true, lastEventAtMs: oldestTimestamp };
      },
    },
    wager: {
      async snapshot(signal) {
        checkCancellation(signal);
        if (!options.wagerEnabled) {
          return { enabled: false, configured: false, paused: false, covered: false };
        }
        if (!options.wagerConfigured) {
          return { enabled: true, configured: false, paused: false, covered: false };
        }
        const status = await options.database.wagerStatus(signal);
        checkCancellation(signal);
        const covered =
          !status.paused || !status.reason?.startsWith(SOLVENCY_PAUSE_REASON_PREFIX);
        return {
          enabled: true,
          configured: true,
          paused: status.paused,
          covered,
        };
      },
    },
    proof: {
      async snapshot(signal) {
        checkCancellation(signal);
        return {
          enabled: options.proofEnabled,
          heartbeatAtMs: null,
          backlog: 0,
          oldestAgeMs: null,
        };
      },
    },
    settlement: {
      async snapshot(signal) {
        checkCancellation(signal);
        return {
          enabled: options.settlementEnabled,
          heartbeatAtMs: null,
          backlog: 0,
          oldestAgeMs: null,
        };
      },
    },
  };
}
