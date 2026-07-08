/**
 * The sol-market branch of a Back/Doubt tap. Funds are already escrowed
 * (internal balance debit inside the wager_stake RPC), so no wallet
 * round-trip happens inside the anti-snipe timing windows — the shared
 * positions row rides the Rep reducer lifecycle unchanged.
 */

import { TUNABLES } from '@calledit/market-engine';
import { WAGER_TUNABLES } from './constants.js';
import { WAGER_COPY, sideLabel } from './copy.js';
import type {
  WagerModuleDeps,
  WagerStakeErrorCode,
  WagerStakeTapArgs,
} from './port.js';

/**
 * Rep multiplier for the doubting side at the quoted claim probability.
 * MUST stay formula-identical to doubtMultiplier in ../pipeline/claims.ts —
 * the wager module may not import Rep-path modules (slice isolation), so the
 * five lines are mirrored here and parity is asserted in stake.test.ts.
 */
export function wagerDoubtMultiplier(probability: number): number {
  const complement = 1 - probability;
  if (complement <= 0) return TUNABLES.MULTIPLIER_MIN;
  const raw = 1 / complement;
  return Math.min(TUNABLES.MULTIPLIER_MAX, Math.max(TUNABLES.MULTIPLIER_MIN, raw));
}

/** Same display rule as bot/cards.ts formatMultiplier, without the × prefix. */
export function multiplierLabel(multiplier: number): string {
  const rounded = multiplier >= 10 ? Math.round(multiplier) : Math.round(multiplier * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function copyForStakeError(code: WagerStakeErrorCode, balanceLamports: bigint): string {
  switch (code) {
    case 'insufficient':
      return WAGER_COPY.insufficient(balanceLamports);
    case 'wrong_side':
      return WAGER_COPY.pickALane();
    case 'cap':
      return WAGER_COPY.capReached(WAGER_TUNABLES.PER_MARKET_STAKE_CAP_LAMPORTS);
    case 'paused':
      return WAGER_COPY.paused();
  }
}

export async function handleStakeTap(
  deps: WagerModuleDeps,
  args: WagerStakeTapArgs,
): Promise<{ reply: string; placed: boolean }> {
  const { market, userId, userName, side, lamports, inPlay, nowMs, idempotencyKey } = args;

  if (lamports <= 0n) return { reply: WAGER_COPY.staleTap(), placed: false };

  // Gate 1: a linked wallet is the onboarding handle — without it the user has
  // no way to have funded (or to ever cash out) a stack.
  const link = await deps.db.getWalletLink(userId);
  if (!link) return { reply: WAGER_COPY.unlinkedOnboarding(), placed: false };

  // Gate 2: persisted circuit breaker. The wager_stake RPC re-checks this
  // atomically; the pre-check just answers fast without burning the advisory
  // lock round-trip while the desk is paused.
  const status = await deps.db.getWagerStatus();
  if (status.paused) return { reply: WAGER_COPY.paused(), placed: false };

  // Multiplier lock — back gets the quoted multiplier, doubt its complement.
  const lockedMultiplier =
    side === 'back' ? market.quote_multiplier : wagerDoubtMultiplier(market.quote_probability);

  const result = await deps.db.wagerStake({
    user_id: userId,
    group_id: market.group_id,
    market_id: market.id,
    side,
    lamports,
    multiplier: lockedMultiplier,
    // Pre-kickoff taps activate immediately; in-play taps ride the
    // delay-arbitrage pending window (reducer sees the shared row).
    state: inPlay ? 'pending' : 'active',
    placed_at_ms: nowMs,
    ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
  });

  if (!result.ok) {
    // Balance is only fetched on the one error whose copy needs it.
    const balance =
      result.code === 'insufficient' ? await deps.db.balanceLamports(userId) : 0n;
    deps.log.info('wager_stake_refused', {
      marketId: market.id,
      userId,
      side,
      lamports: lamports.toString(),
      code: result.code,
    });
    return { reply: copyForStakeError(result.code, balance), placed: false };
  }

  if ('duplicate' in result) {
    // At-least-once replay of the same client key — the original stake stands.
    deps.log.info('wager_stake_duplicate', { marketId: market.id, userId, side });
    return { reply: WAGER_COPY.stakeReplayed(), placed: false };
  }

  // Deposit-credited and cashout notifications route to the last group the
  // user wagered in (the bot cannot DM users who never started it).
  await deps.db.setLastWagerGroup(userId, market.group_id);
  deps.log.info('wager_position_placed', {
    marketId: market.id,
    positionId: result.position_id,
    userId,
    side,
    lamports: lamports.toString(),
    state: inPlay ? 'pending' : 'active',
  });
  return {
    reply: WAGER_COPY.stakePlaced(
      userName,
      sideLabel(side),
      lamports,
      multiplierLabel(lockedMultiplier),
    ),
    placed: true,
  };
}
