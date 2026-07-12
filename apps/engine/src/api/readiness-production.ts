import { SOLVENCY_PAUSE_REASON_PREFIX } from '../wager/constants.js';
import type { WagerRuntimeMode } from '../env.js';
import type { WagerModule } from '../wager/module.js';
import type { EngineReadinessPorts, QueueReadinessPort } from './readiness-checks.js';
import { createSupabaseReadinessClient } from './readiness-supabase.js';

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
  starterBudget(
    signal: AbortSignal,
  ): Promise<{ readonly enabled: boolean; readonly available: boolean }>;
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
  readonly wagerRuntimeMode: WagerRuntimeMode;
  readonly wagerModuleKind: WagerModule['kind'] | null;
  readonly starterGrantsEnabled: boolean;
  readonly starterIntakeEnabled: boolean;
  readonly proofEnabled: boolean;
  readonly settlementEnabled: boolean;
  /** Injected durable workers expose real leased-job backlog and heartbeat. */
  readonly proofQueue?: QueueReadinessPort;
  readonly settlementQueue?: QueueReadinessPort;
}

export interface SupabaseProductionReadinessOptions
  extends Omit<ProductionReadinessOptions, 'database'> {
  readonly supabaseUrl: string;
  readonly supabaseServiceRoleKey: string;
}

function checkCancellation(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function runtimeMatches(
  requested: WagerRuntimeMode,
  constructed: WagerModule['kind'] | null,
): boolean {
  return requested === 'disabled' ? constructed === null : requested === constructed;
}

function assertNeverRuntimeMode(mode: never): never {
  throw new TypeError(`unsupported wager runtime mode: ${String(mode)}`);
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
        const matches = runtimeMatches(options.wagerRuntimeMode, options.wagerModuleKind);
        if (!matches) {
          return {
            enabled: options.wagerRuntimeMode !== 'disabled',
            configured: false,
            runtimeMatches: false,
            paused: false,
            covered: false,
            starterIntakeReady: false,
          };
        }
        switch (options.wagerRuntimeMode) {
          case 'disabled':
            return {
              enabled: false,
              configured: false,
              runtimeMatches: true,
              paused: false,
              covered: false,
              starterIntakeReady: false,
            };
          case 'starter_only': {
            const [status, budget] = await Promise.all([
              options.database.wagerStatus(signal),
              options.database.starterBudget(signal),
            ]);
            checkCancellation(signal);
            return {
              enabled: true,
              configured: true,
              runtimeMatches: true,
              paused: status.paused,
              covered: true,
              starterIntakeReady:
                options.starterIntakeEnabled && budget.enabled && budget.available,
            };
          }
          case 'funded': {
            if (options.starterGrantsEnabled) {
              return {
                enabled: true,
                configured: false,
                runtimeMatches: true,
                paused: false,
                covered: false,
                starterIntakeReady: false,
              };
            }
            const status = await options.database.wagerStatus(signal);
            checkCancellation(signal);
            const covered =
              !status.paused || !status.reason?.startsWith(SOLVENCY_PAUSE_REASON_PREFIX);
            return {
              enabled: true,
              configured: true,
              runtimeMatches: true,
              paused: status.paused,
              covered,
              starterIntakeReady: true,
            };
          }
          default:
            return assertNeverRuntimeMode(options.wagerRuntimeMode);
        }
      },
    },
    proof: {
      async snapshot(signal) {
        checkCancellation(signal);
        if (options.proofQueue !== undefined) {
          return options.proofQueue.snapshot(signal);
        }
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
        if (options.settlementQueue !== undefined) {
          return options.settlementQueue.snapshot(signal);
        }
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

export function createSupabaseProductionReadinessPorts(
  options: SupabaseProductionReadinessOptions,
): Omit<EngineReadinessPorts, 'telegram'> {
  return createProductionReadinessPorts({
    ...options,
    database: createSupabaseReadinessClient({
      baseUrl: options.supabaseUrl,
      serviceRoleKey: options.supabaseServiceRoleKey,
    }),
  });
}
