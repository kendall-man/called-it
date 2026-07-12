/**
 * setInterval ticks: fixtures snapshot sync (15 min), morning slate for
 * nudge-mode groups, unconfirmed-claim TTL expiry, the kickoff void sweep
 * (abandoned zero-bet offer markets), and the settlement sweeper
 * (at-least-once chat delivery for receipts).
 */

import { TUNABLES } from '@calledit/market-engine';
import type { Deps, MarketRow } from '../ports.js';
import { ENGINE } from '../engineConstants.js';
import type { Poster } from '../bot/poster.js';
import type { Say } from '../bot/copy.js';
import type { Settler } from '../settle/settler.js';
import type { IngestSupervisor } from '../ingest/supervisor.js';
import { voidAbandonedMarket } from '../pipeline/void.js';
import type { WagerCronRegistry, WagerModule } from '../wager/module.js';

export interface CronHandles {
  stop(): void;
}

/** Durable settlement/proof work is injected by Task16's runtime composition. */
export interface DurableRecoveryCron {
  tick(): Promise<void>;
  stop(): void;
}

export interface BetaSettlementReconciler {
  tick(): Promise<void>;
}

function assertNeverWagerModule(module: never): never {
  throw new TypeError(`unsupported wager module: ${JSON.stringify(module)}`);
}

export function registerWagerCronWorkers(
  wager: WagerModule | null,
  registry: WagerCronRegistry,
): void {
  if (wager === null) return;
  wager.registerSettlementRecovery(registry);
  switch (wager.kind) {
    case 'starter_only':
      return;
    case 'funded':
      wager.registerFundedWorkers(registry);
      return;
    default:
      assertNeverWagerModule(wager);
  }
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function utcDayBounds(nowMs: number): { fromMs: number; toMs: number } {
  const day = new Date(nowMs);
  const fromMs = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  return { fromMs, toMs: fromMs + 24 * 60 * 60_000 };
}

export async function syncFixtures(deps: Deps): Promise<void> {
  try {
    const rows = await deps.tx.fetchFixtures();
    if (rows.length > 0) await deps.db.upsertFixtures(rows);
    deps.log.info('fixtures_synced', { count: rows.length });
  } catch {
    deps.log.warn('fixtures_sync_failed');
  }
}

async function expireClaims(deps: Deps): Promise<void> {
  try {
    const expired = await deps.db.expireOverdueClaims(new Date(deps.now()).toISOString());
    if (expired.length > 0) {
      deps.log.info('claims_expired', { count: expired.length, ids: expired.map((c) => c.id) });
    }
  } catch {
    deps.log.warn('claim_expiry_failed');
  }
}

/** A re-posted receipt gets this long to land before the sweeper may retry it. */
const SWEEPER_RETRY_GUARD_MS = 5 * 60_000;

/** Re-posts receipts for settled-but-unposted markets (crash between settle and send). */
export async function sweepUnpostedSettlements(
  deps: Deps,
  settler: Settler,
  inFlight: Map<string, number>,
): Promise<void> {
  try {
    const rows = await deps.db.unpostedSettlements();
    const nowMs = deps.now();
    for (const settlement of rows) {
      const attemptedAt = inFlight.get(settlement.market_id);
      if (attemptedAt !== undefined && nowMs - attemptedAt < SWEEPER_RETRY_GUARD_MS) continue;
      const market: MarketRow | null = await deps.db.getMarket(settlement.market_id);
      if (!market) continue;
      inFlight.set(settlement.market_id, nowMs);
      deps.log.info('sweeper_reposting', { marketId: market.id, outcome: settlement.outcome });
      await settler.postReceipt(market, settlement.outcome);
    }
  } catch {
    deps.log.warn('sweeper_failed');
  }
}

/**
 * Void offer markets that nobody bet on once their fixture kicks off — "no one
 * showed, so the SOL never moved". Replay markets are exempt (they run on a
 * virtual clock and settle themselves).
 */
async function voidAbandonedMarkets(deps: Deps): Promise<void> {
  try {
    const groups = await deps.db.listGroups();
    for (const group of groups) {
      const openMarkets = await deps.db.openMarketsForGroup(group.id);
      for (const market of openMarkets) {
        if (market.is_replay) continue;
        const fixture = await deps.db.getFixture(market.fixture_id);
        if (!fixture || fixture.phase === 'NS') continue; // not kicked off yet
        const positions = await deps.db.positionsForMarket(market.id);
        if (positions.some((position) => position.state !== 'void')) continue; // someone bet
        await voidAbandonedMarket(deps, market);
      }
    }
  } catch {
    deps.log.warn('void_sweep_failed');
  }
}

/** Today's fixtures posted to nudge-mode groups. */
async function runMorningSlate(deps: Deps, poster: Poster, say: Say): Promise<void> {
  const { fromMs, toMs } = utcDayBounds(deps.now());
  const fixtures = await deps.db.fixturesBetween(fromMs, toMs);
  if (fixtures.length === 0) return;
  const fixtureList = fixtures
    .map((f) => {
      const time = f.kickoff_at ? new Date(f.kickoff_at).toISOString().slice(11, 16) : '--:--';
      return `${f.p1_name} vs ${f.p2_name} (${time} UTC)`;
    })
    .join(' · ');
  const groups = await deps.db.listGroups();
  for (const group of groups) {
    if (group.chattiness !== 'nudge' || !group.is_admin) continue;
    poster.post(group.id, await say('slate_intro', { fixtures: fixtureList }));
  }
  deps.log.info('morning_slate_posted', { fixtures: fixtures.length });
}

export function startCrons(args: {
  deps: Deps;
  poster: Poster;
  say: Say;
  settler: Settler;
  supervisor: IngestSupervisor;
  settlementReconciler: BetaSettlementReconciler;
  durableRecovery?: DurableRecoveryCron;
}): CronHandles {
  const { deps, poster, say, settler, supervisor, settlementReconciler, durableRecovery } = args;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const sweeperInFlight = new Map<string, number>();
  let slateDoneFor = '';

  // Boot-time kick so a fresh deploy is immediately useful.
  void syncFixtures(deps).then(async () => {
    await supervisor.refresh();
    await settlementReconciler.tick();
  });
  if (durableRecovery) void durableRecovery.tick();

  registerWagerCronWorkers(deps.wager, {
    every(intervalMs: number, task: () => void | Promise<void>): void {
      timers.push(
        setInterval(() => {
          void task();
        }, intervalMs),
      );
    },
  });

  timers.push(
    setInterval(() => {
      void syncFixtures(deps);
    }, ENGINE.FIXTURES_SYNC_MS),
  );

  timers.push(
    setInterval(() => {
      void supervisor.refresh();
    }, ENGINE.INGEST_REFRESH_MS),
  );

  timers.push(
    setInterval(() => {
      void settler.tick(deps.now());
    }, ENGINE.DEBOUNCE_TICK_MS),
  );

  timers.push(
    setInterval(() => {
      void settlementReconciler.tick();
    }, ENGINE.SETTLEMENT_RECONCILIATION_MS),
  );

  timers.push(
    setInterval(() => {
      void (async () => {
        await expireClaims(deps);
        await sweepUnpostedSettlements(deps, settler, sweeperInFlight);
        await voidAbandonedMarkets(deps);

        const nowMs = deps.now();
        const hour = new Date(nowMs).getUTCHours();
        const dateKey = utcDayKey(nowMs);
        if (hour === TUNABLES.MORNING_SLATE_HOUR_UTC && slateDoneFor !== dateKey) {
          slateDoneFor = dateKey;
          await runMorningSlate(deps, poster, say).catch(() =>
            deps.log.warn('slate_failed'),
          );
        }
      })();
    }, ENGINE.MINUTE_TICK_MS),
  );

  if (durableRecovery) {
    timers.push(
      setInterval(() => {
        void durableRecovery.tick();
      }, ENGINE.MINUTE_TICK_MS),
    );
  }

  return {
    stop() {
      for (const timer of timers) clearInterval(timer);
      durableRecovery?.stop();
    },
  };
}
