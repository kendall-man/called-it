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
import { composeClaimCard } from '../pipeline/render.js';
import { closeClaimSurface, type ClaimSurfaceStore } from '../pipeline/claim-surface.js';
import { CLAIM_EXPIRED_LINE } from '../bot/cards.js';
import { marketStakeKeyboard } from '../bot/keyboards.js';
import type { WagerCronRegistry, WagerModule } from '../wager/module.js';
import { createAllowlistedBackgroundDb } from '../background/allowlisted-db.js';

export interface CronHandles {
  stop(): void;
}

/** Periodic escrow ops probe (readiness → ops-chat alerts) owned by main. */
export interface EscrowOpsMonitor {
  tick(): Promise<void>;
}

/** Re-checks escrow provisioning for a market's positions (single attempt). */
export interface EscrowPausedCardRecoveryPorts {
  ready(market: MarketRow): Promise<boolean>;
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
  custodyMode: 'legacy' | 'escrow' = 'legacy',
): void {
  if (wager === null) return;
  wager.registerSettlementRecovery(registry);
  switch (wager.kind) {
    case 'starter_only':
      return;
    case 'funded':
      wager.registerFundedWorkers(registry, {
        legacyDepositIntakeEnabled: custodyMode === 'legacy',
      });
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

async function expireClaims(
  deps: Deps,
  poster: Poster,
  claimSurface: ClaimSurfaceStore | undefined,
): Promise<void> {
  try {
    const backgroundDb = createAllowlistedBackgroundDb(deps.db, deps.env);
    const expired = await backgroundDb.expireOverdueClaims(new Date(deps.now()).toISOString());
    if (expired.length > 0) {
      deps.log.info('claims_expired', { count: expired.length, ids: expired.map((c) => c.id) });
      // Single-message lifecycle: collapse each expired claim's surface to a
      // one-line close so no dead consent gate is left behind (flag off: no-op).
      for (const claim of expired) {
        closeClaimSurface(poster, claimSurface, claim, CLAIM_EXPIRED_LINE);
      }
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
    const backgroundDb = createAllowlistedBackgroundDb(deps.db, deps.env);
    const rows = await backgroundDb.unpostedSettlements();
    const nowMs = deps.now();
    for (const settlement of rows) {
      const attemptedAt = inFlight.get(settlement.market_id);
      if (attemptedAt !== undefined && nowMs - attemptedAt < SWEEPER_RETRY_GUARD_MS) continue;
      const market: MarketRow | null = await backgroundDb.getMarket(settlement.market_id);
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
    const backgroundDb = createAllowlistedBackgroundDb(deps.db, deps.env);
    const groups = await backgroundDb.listGroups();
    for (const group of groups) {
      const openMarkets = await backgroundDb.openMarketsForGroup(group.id);
      for (const market of openMarkets) {
        if (market.is_replay) continue;
        const fixture = await deps.db.getFixture(market.fixture_id);
        if (!fixture || fixture.phase === 'NS') continue; // not kicked off yet
        const positions = await backgroundDb.positionsForMarket(market.id);
        if (positions.some((position) => position.state !== 'void')) continue; // someone bet
        await voidAbandonedMarket({ db: backgroundDb, wager: deps.wager, log: deps.log }, market);
      }
    }
  } catch {
    deps.log.warn('void_sweep_failed');
  }
}

/**
 * Re-arm cards born paused: a live escrow market whose provisioning failed at
 * mint posts its card with positions paused and no keyboard, and nothing ever
 * re-enables it. Once provisioning reports ready, re-edit the card WITH the
 * stake keyboard. `recovered` remembers finished markets so each costs at most
 * one card edit per process lifetime (editing an already-live card is a
 * Telegram "not modified" no-op); replay markets provision under the mint lock
 * and are skipped so this sweep never long-polls.
 */
export async function recoverPausedEscrowCards(
  deps: Deps,
  poster: Poster,
  recovery: EscrowPausedCardRecoveryPorts,
  recovered: Set<string>,
): Promise<void> {
  if (deps.env.WAGER_CUSTODY_MODE !== 'escrow') return;
  try {
    const backgroundDb = createAllowlistedBackgroundDb(deps.db, deps.env);
    const groups = await backgroundDb.listGroups();
    for (const group of groups) {
      const openMarkets = await backgroundDb.openMarketsForGroup(group.id);
      for (const market of openMarkets) {
        if (
          market.is_replay ||
          market.card_tg_message_id === null ||
          recovered.has(market.id) ||
          (market.status !== 'open' && market.status !== 'pending_lineup')
        ) continue;
        if (!(await recovery.ready(market))) continue;
        const currency = market.currency === 'usdc' ? 'usdc' : 'sol';
        if (deps.wager !== null && !(await deps.wager.stakesAvailable(currency))) continue;
        const card = await composeClaimCard(
          { ...deps, db: backgroundDb },
          market,
          { positionsAvailable: true },
        );
        if (card === null || card.messageId === null) continue;
        poster.editCard(card.chatId, market.id, card.messageId, card.text, marketStakeKeyboard(deps, market));
        recovered.add(market.id);
        deps.log.info('escrow_paused_card_recovered', { marketId: market.id });
      }
    }
  } catch {
    deps.log.warn('paused_card_recovery_failed');
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
  const groups = await createAllowlistedBackgroundDb(deps.db, deps.env).listGroups();
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
  /** Re-arms escrow cards that posted with positions paused (escrow custody only). */
  escrowPausedCards?: EscrowPausedCardRecoveryPorts;
  /** Minute-grade escrow readiness probe feeding the ops chat alerts. */
  escrowOps?: EscrowOpsMonitor;
  /**
   * Single-message lifecycle surface store (STAKE_LADDER_ENABLED). Present only
   * when the flag is on; lets claim-expiry collapse a dead consent gate to a
   * close-line instead of leaving it live.
   */
  claimSurface?: ClaimSurfaceStore;
}): CronHandles {
  const {
    deps, poster, say, settler, supervisor, settlementReconciler, durableRecovery,
    escrowPausedCards, escrowOps, claimSurface,
  } = args;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const sweeperInFlight = new Map<string, number>();
  const recoveredPausedCards = new Set<string>();
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
  }, deps.env.WAGER_CUSTODY_MODE);

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
        await expireClaims(deps, poster, claimSurface);
        await sweepUnpostedSettlements(deps, settler, sweeperInFlight);
        await voidAbandonedMarkets(deps);
        if (escrowPausedCards !== undefined) {
          await recoverPausedEscrowCards(deps, poster, escrowPausedCards, recoveredPausedCards);
        }
        if (escrowOps !== undefined) {
          await escrowOps.tick().catch(() => deps.log.warn('escrow_ops_probe_failed'));
        }

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
