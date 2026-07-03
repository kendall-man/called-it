/**
 * setInterval ticks: fixtures snapshot sync (15 min), matchday top-up,
 * morning slate for nudge-mode groups, unconfirmed-claim TTL expiry, and the
 * settlement sweeper (at-least-once chat delivery for receipts).
 */

import { TUNABLES } from '@calledit/market-engine';
import type { Deps, MarketRow } from '../ports.js';
import { ENGINE } from '../engineConstants.js';
import type { Poster } from '../bot/poster.js';
import type { Say } from '../bot/copy.js';
import type { Settler } from '../settle/settler.js';
import type { IngestSupervisor } from '../ingest/supervisor.js';
import { computeWinners } from '../settle/settler.js';

export interface CronHandles {
  stop(): void;
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
  } catch (err) {
    deps.log.warn('fixtures_sync_failed', { error: String(err) });
  }
}

async function expireClaims(deps: Deps): Promise<void> {
  try {
    const expired = await deps.db.expireOverdueClaims(new Date(deps.now()).toISOString());
    if (expired.length > 0) {
      deps.log.info('claims_expired', { count: expired.length, ids: expired.map((c) => c.id) });
    }
  } catch (err) {
    deps.log.warn('claim_expiry_failed', { error: String(err) });
  }
}

/** A re-posted receipt gets this long to land before the sweeper may retry it. */
const SWEEPER_RETRY_GUARD_MS = 5 * 60_000;

/** Re-posts receipts for settled-but-unposted markets (crash between settle and send). */
async function sweepUnpostedSettlements(
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
      const positions = await deps.db.positionsForMarket(market.id);
      const winners = computeWinners(positions, settlement.outcome);
      deps.log.info('sweeper_reposting', { marketId: market.id, outcome: settlement.outcome });
      await settler.postReceipt(market, settlement.outcome, winners);
    }
  } catch (err) {
    deps.log.warn('sweeper_failed', { error: String(err) });
  }
}

async function hasCoveredFixtureToday(deps: Deps): Promise<boolean> {
  const { fromMs, toMs } = utcDayBounds(deps.now());
  const fixtures = await deps.db.fixturesBetween(fromMs, toMs).catch(() => []);
  return fixtures.length > 0;
}

/** Top everyone up to the floor at the configured UTC hour on matchdays. */
async function runMatchdayTopup(deps: Deps): Promise<void> {
  const dateKey = utcDayKey(deps.now());
  const groups = await deps.db.listGroups();
  for (const group of groups) {
    const memberships = await deps.db.listMemberships(group.id).catch(() => []);
    for (const membership of memberships) {
      const balance = await deps.db
        .balance(group.id, membership.user_id)
        .catch(() => membership.points_cached);
      if (balance >= TUNABLES.MATCHDAY_TOPUP_FLOOR) continue;
      await deps.db.postLedger({
        group_id: group.id,
        user_id: membership.user_id,
        market_id: null,
        kind: 'topup',
        amount: TUNABLES.MATCHDAY_TOPUP_FLOOR - balance,
        idempotency_key: `topup:${group.id}:${membership.user_id}:${dateKey}`,
      });
    }
  }
  deps.log.info('matchday_topup_done', { dateKey, groups: groups.length });
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
}): CronHandles {
  const { deps, poster, say, settler, supervisor } = args;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const sweeperInFlight = new Map<string, number>();
  let topupDoneFor = '';
  let slateDoneFor = '';

  // Boot-time kick so a fresh deploy is immediately useful.
  void syncFixtures(deps).then(() => supervisor.refresh());

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
      void (async () => {
        await expireClaims(deps);
        await sweepUnpostedSettlements(deps, settler, sweeperInFlight);

        const nowMs = deps.now();
        const hour = new Date(nowMs).getUTCHours();
        const dateKey = utcDayKey(nowMs);
        if (hour === TUNABLES.MATCHDAY_TOPUP_HOUR_UTC && topupDoneFor !== dateKey) {
          if (await hasCoveredFixtureToday(deps)) {
            topupDoneFor = dateKey;
            await runMatchdayTopup(deps).catch((err) =>
              deps.log.warn('topup_failed', { error: String(err) }),
            );
          }
        }
        if (hour === TUNABLES.MORNING_SLATE_HOUR_UTC && slateDoneFor !== dateKey) {
          slateDoneFor = dateKey;
          await runMorningSlate(deps, poster, say).catch((err) =>
            deps.log.warn('slate_failed', { error: String(err) }),
          );
        }
      })();
    }, ENGINE.MINUTE_TICK_MS),
  );

  return {
    stop() {
      for (const timer of timers) clearInterval(timer);
    },
  };
}
