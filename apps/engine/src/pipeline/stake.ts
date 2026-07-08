/**
 * Transport-agnostic staking core. The Telegram callback handler and the
 * engine HTTP API both route through executeStake so the guards (one-side,
 * cap, balance, in-play cutoff, positive-integer amount) and the
 * per-(market,user) lock live in exactly one place.
 */

import { TUNABLES } from '@calledit/market-engine';
import type { Deps, MarketRow, PositionRow } from '../ports.js';
import { doubtMultiplier } from './claims.js';

export interface StakeCommand {
  groupId: number;
  marketId: string;
  user: { id: number; displayName: string; username: string | null };
  side: 'back' | 'doubt';
  amount: number;
  /**
   * Replay dedup for at-least-once callers (the eve concierge re-runs
   * interrupted tool steps). Omitted on the button path — a tap is unique.
   */
  idempotencyKey?: string;
}

export type StakeOutcome =
  /** Position placed. */
  | { kind: 'ok'; position: PositionRow; market: MarketRow; lockedMultiplier: number }
  /** Same idempotency key already landed — success, but nothing new happened. */
  | { kind: 'duplicate' }
  /** Another stake by the same user on the same market is mid-flight. */
  | { kind: 'busy' }
  /** Market unknown / other group / bad amount — the "that ship has sailed" class. */
  | { kind: 'unavailable' }
  /** Market exists but is not accepting stakes. */
  | { kind: 'closed'; status: MarketRow['status'] }
  /** A guard said no; copyKey maps onto the existing in-character templates. */
  | {
      kind: 'rejected';
      copyKey: 'window_closed' | 'pick_a_lane' | 'cap_reached' | 'insufficient_rep';
      vars: Record<string, string | number>;
    };

/**
 * Per-(market, user) in-process mutex. dispatchCallback runs callback queries
 * concurrently and the HTTP API adds a second concurrent caller, so the
 * one-side/cap/balance reads and the insert must not interleave — the TOCTOU
 * double-stakes, bypasses the cap, and can drive a balance negative. A Set
 * suffices because this engine process is the single DB writer (the deployed
 * schema has no unique/exclusion constraint to lean on).
 */
const inFlightStakes = new Set<string>();

/** Runs task under the (marketId, userId) stake lock; null = lock was busy. */
export async function withStakeLock<T>(
  marketId: string,
  userId: number,
  task: () => Promise<T>,
): Promise<T | null> {
  const key = `${marketId}:${userId}`;
  if (inFlightStakes.has(key)) return null;
  inFlightStakes.add(key);
  try {
    return await task();
  } finally {
    inFlightStakes.delete(key);
  }
}

/** Upsert the user + membership (seeding Rep on first sight) — deps-only. */
export async function ensureMemberSeen(
  deps: Deps,
  groupId: number,
  user: StakeCommand['user'],
): Promise<void> {
  await deps.db.upsertUser({
    id: user.id,
    display_name: user.displayName,
    username: user.username,
  });
  const { created } = await deps.db.ensureMembership(groupId, user.id);
  if (created) {
    await deps.db.postLedger({
      group_id: groupId,
      user_id: user.id,
      market_id: null,
      kind: 'seed',
      amount: TUNABLES.STARTING_BALANCE,
      idempotency_key: `seed:${groupId}:${user.id}`,
    });
    deps.log.info('member_seeded', { groupId, userId: user.id });
  }
}

export async function executeStake(deps: Deps, cmd: StakeCommand): Promise<StakeOutcome> {
  const outcome = await withStakeLock(cmd.marketId, cmd.user.id, () => stakeLocked(deps, cmd));
  return outcome ?? { kind: 'busy' };
}

async function stakeLocked(deps: Deps, cmd: StakeCommand): Promise<StakeOutcome> {
  const market = await deps.db.getMarket(cmd.marketId);
  if (!market || market.group_id !== cmd.groupId) return { kind: 'unavailable' };
  // This core moves REP only. SOL markets belong to the wager module (its own
  // funds, DB advisory locks, and copy) — never let a Rep debit ride a
  // SOL-denominated book, whichever transport asked.
  if (market.currency === 'sol') return { kind: 'unavailable' };
  if (market.status !== 'open' && market.status !== 'pending_lineup') {
    return { kind: 'closed', status: market.status };
  }
  // Positive-integer invariant: a negative stake would CREDIT Rep via the
  // signed ledger, and NaN slips the >/< guards silently.
  if (!Number.isInteger(cmd.amount) || cmd.amount <= 0) return { kind: 'unavailable' };

  if (cmd.idempotencyKey !== undefined) {
    // Replay from an at-least-once caller: report success, change nothing.
    if (await deps.db.hasLedgerEntry(stakeIdempotencyKey(cmd.idempotencyKey))) {
      return { kind: 'duplicate' };
    }
  }

  const fixture = await deps.db.getFixture(market.fixture_id);
  const inPlay = fixture !== null && fixture.phase !== 'NS';
  if (
    inPlay &&
    fixture.minute !== null &&
    fixture.minute >= TUNABLES.INPLAY_STAKE_CUTOFF_MINUTE
  ) {
    return { kind: 'rejected', copyKey: 'window_closed', vars: {} };
  }

  await ensureMemberSeen(deps, cmd.groupId, cmd.user);
  const positions = await deps.db.positionsForMarket(market.id);
  const mine = positions.filter((p) => p.user_id === cmd.user.id && p.state !== 'void');
  if (mine.some((p) => p.side !== cmd.side)) {
    return { kind: 'rejected', copyKey: 'pick_a_lane', vars: { user: cmd.user.displayName } };
  }
  const committed = mine.reduce((sum, p) => sum + p.stake, 0);
  if (committed + cmd.amount > TUNABLES.PER_MARKET_STAKE_CAP) {
    return { kind: 'rejected', copyKey: 'cap_reached', vars: { cap: TUNABLES.PER_MARKET_STAKE_CAP } };
  }
  const balance = await deps.db.balance(cmd.groupId, cmd.user.id);
  if (balance < cmd.amount) {
    return {
      kind: 'rejected',
      copyKey: 'insufficient_rep',
      vars: { balance, user: cmd.user.displayName },
    };
  }

  const lockedMultiplier =
    cmd.side === 'back' ? market.quote_multiplier : doubtMultiplier(market.quote_probability);
  const position = await deps.db.insertPosition({
    market_id: market.id,
    user_id: cmd.user.id,
    side: cmd.side,
    stake: cmd.amount,
    locked_multiplier: lockedMultiplier,
    locked_odds_message_id: market.odds_message_id,
    locked_odds_ts: market.odds_ts,
    // Pre-kickoff stakes activate immediately; in-play stakes ride the
    // delay-arbitrage pending window (PENDING_TAP_WINDOW_MS in the engine).
    state: inPlay ? 'pending' : 'active',
    placed_at_ms: deps.now(),
  });
  await deps.db.postLedger({
    group_id: cmd.groupId,
    user_id: cmd.user.id,
    market_id: market.id,
    kind: 'stake',
    amount: -cmd.amount,
    idempotency_key:
      cmd.idempotencyKey !== undefined
        ? stakeIdempotencyKey(cmd.idempotencyKey)
        : `stake:${position.id}`,
  });
  deps.log.info('position_placed', {
    marketId: market.id,
    positionId: position.id,
    userId: cmd.user.id,
    side: cmd.side,
    stake: cmd.amount,
    state: position.state,
  });
  return { kind: 'ok', position, market, lockedMultiplier };
}

/** Namespaced so caller-supplied keys can never collide with `stake:{uuid}` rows. */
function stakeIdempotencyKey(key: string): string {
  return `stake-api:${key}`;
}
