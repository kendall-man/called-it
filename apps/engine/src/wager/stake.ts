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
    case 'closed':
      return WAGER_COPY.marketClosed();
    case 'starter_unavailable':
      return WAGER_COPY.starterUnavailable();
    case 'budget_exhausted':
      return WAGER_COPY.budgetExhausted();
    case 'wallet_required':
      return WAGER_COPY.walletRequired();
  }
}

export async function handleStakeTap(
  deps: WagerModuleDeps,
  args: WagerStakeTapArgs,
): Promise<{ reply: string; placed: boolean }> {
  const { market, userId, userName, side, lamports, inPlay, nowMs, source } = args;

  if (lamports <= 0n) return { reply: WAGER_COPY.staleTap(), placed: false };

  const allowStarter =
    source.kind === 'telegram_default_card' &&
    lamports === WAGER_TUNABLES.PRESET_STAKES_LAMPORTS[0] &&
    deps.starterGrantsEnabled &&
    deps.stakeAcceptanceEnabled;
  const idempotencyKey =
    source.kind === 'durable_source'
      ? source.idempotencyKey
      : `telegram:callback:${source.callbackId}`;

  // Only the atomic starter RPC path may place before a wallet is linked.
  const link = await deps.db.getWalletLink(userId);
  if (!link && !allowStarter) {
    return { reply: WAGER_COPY.unlinkedOnboarding(), placed: false };
  }

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
    allow_starter: allowStarter,
    idempotency_key: idempotencyKey,
  });

  if (!result.ok) {
    // Balance is only fetched on the one error whose copy needs it.
    const balance =
      result.code === 'insufficient' ? await deps.db.balanceLamports(userId) : 0n;
    deps.log.info('wager_stake_refused', {
      marketId: market.id,
      side,
      lamports: lamports.toString(),
      code: result.code,
    });
    return { reply: copyForStakeError(result.code, balance), placed: false };
  }

  if ('duplicate' in result) {
    // The original commit is authoritative; do not refresh a card on replay.
    deps.log.info('wager_stake_duplicate', { marketId: market.id, side });
    return {
      reply: WAGER_COPY.stakePlaced(
        userName,
        sideLabel(side),
        lamports,
        multiplierLabel(lockedMultiplier),
      ),
      placed: false,
    };
  }

  // Deposit-credited and cashout notifications route to the last group the
  // user wagered in (the bot cannot DM users who never started it).
  await deps.db.setLastWagerGroup(userId, market.group_id);
  deps.log.info('wager_position_placed', {
    marketId: market.id,
    positionId: result.position_id,
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
