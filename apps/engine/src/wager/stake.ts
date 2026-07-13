/**
 * The sol-market branch of a Back/Doubt tap. Funds are already escrowed
 * (internal balance debit inside the wager_stake RPC), so no wallet
 * round-trip happens inside the anti-snipe timing windows — the shared
 * positions row rides the Rep reducer lifecycle unchanged.
 */

import { TUNABLES } from '@calledit/market-engine';
import { WAGER_TUNABLES } from './constants.js';
import { createWagerCopy, sideLabel, type WagerCopy } from './copy.js';
import type {
  WagerStakeDeps,
  WagerStakeErrorCode,
  WagerStakeResult,
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

function copyForStakeError(copy: WagerCopy, code: WagerStakeErrorCode, balanceLamports: bigint): string {
  switch (code) {
    case 'insufficient':
      return copy.insufficient(balanceLamports);
    case 'wrong_side':
      return copy.pickALane();
    case 'cap':
      return copy.capReached(WAGER_TUNABLES.PER_MARKET_STAKE_CAP_LAMPORTS);
    case 'paused':
      return copy.paused();
    case 'closed':
      return copy.marketClosed();
    case 'starter_unavailable':
      return copy.starterUnavailable();
    case 'budget_exhausted':
      return copy.budgetExhausted();
    case 'wallet_required':
      return copy.walletRequired();
  }
}

function assertNeverRuntimeMode(mode: never): never {
  throw new TypeError(`unsupported wager runtime mode: ${String(mode)}`);
}

export async function handleStakeTap(
  deps: WagerStakeDeps,
  args: WagerStakeTapArgs,
): Promise<{ reply: string; placed: boolean }> {
  const { market, userId, userName, side, lamports, inPlay, nowMs, source } = args;
  const copy = createWagerCopy(deps.solanaNetwork ?? 'devnet');

  if (lamports <= 0n) return { reply: copy.staleTap(), placed: false };

  const idempotencyKey =
    source.kind === 'durable_source'
      ? source.idempotencyKey
      : `telegram:callback:${source.callbackId}`;

  switch (deps.runtimeMode) {
    case 'starter_only':
      if (
        source.kind !== 'telegram_default_card'
        || lamports !== WAGER_TUNABLES.PRESET_STAKES_LAMPORTS[0]
        || !deps.starterGrantsEnabled
        || !deps.stakeAcceptanceEnabled
      ) {
        return { reply: copy.starterUnavailable(), placed: false };
      }
      break;
    case 'funded': {
      const link = await deps.db.getWalletLink(userId);
      if (!link) {
        return { reply: copy.unlinkedOnboarding(), placed: false };
      }
      break;
    }
    default:
      return assertNeverRuntimeMode(deps);
  }

  // Gate 2: persisted circuit breaker. The wager_stake RPC re-checks this
  // atomically; the pre-check just answers fast without burning the advisory
  // lock round-trip while the desk is paused.
  const status = await deps.db.getWagerStatus();
  if (status.paused) return { reply: copy.paused(), placed: false };

  // Multiplier lock — back gets the quoted multiplier, doubt its complement.
  const lockedMultiplier =
    side === 'back' ? market.quote_multiplier : wagerDoubtMultiplier(market.quote_probability);

  const stakeInput = {
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
    idempotency_key: idempotencyKey,
  } as const;
  let result: WagerStakeResult;
  switch (deps.runtimeMode) {
    case 'starter_only':
      result = await deps.db.wagerStarterStake(stakeInput);
      break;
    case 'funded':
      result = await deps.db.wagerStake({ ...stakeInput, starterOnly: false });
      break;
    default:
      return assertNeverRuntimeMode(deps);
  }

  if (!result.ok) {
    // Balance is only fetched on the one error whose copy needs it.
    const balance =
      result.code === 'insufficient' && deps.runtimeMode === 'funded'
        ? await deps.db.balanceLamports(userId)
        : 0n;
    deps.log.info('wager_stake_refused', {
      marketId: market.id,
      side,
      lamports: lamports.toString(),
      code: result.code,
    });
    return { reply: copyForStakeError(copy, result.code, balance), placed: false };
  }

  if ('duplicate' in result) {
    // The original commit is authoritative; do not refresh a card on replay.
    deps.log.info('wager_stake_duplicate', { marketId: market.id, side });
    return {
      reply: copy.stakePlaced(
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
  switch (deps.runtimeMode) {
    case 'starter_only':
      break;
    case 'funded':
      await deps.db.setLastWagerGroup(userId, market.group_id);
      break;
    default:
      return assertNeverRuntimeMode(deps);
  }
  deps.log.info('wager_position_placed', {
    marketId: market.id,
    positionId: result.position_id,
    side,
    lamports: lamports.toString(),
    state: inPlay ? 'pending' : 'active',
  });
  return {
    reply: copy.stakePlaced(
      userName,
      sideLabel(side),
      lamports,
      multiplierLabel(lockedMultiplier),
    ),
    placed: true,
  };
}
