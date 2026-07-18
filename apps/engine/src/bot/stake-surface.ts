/**
 * Stake-flow surface helpers.
 *
 * The SHARED market card is the multi-participant surface: while a market is
 * open it ALWAYS shows the two side buttons for every member (via
 * `marketStakeKeyboard`) and NEVER morphs into a per-user stepper. The stepper
 * lives in a per-user ephemeral message instead — `renderStepperEphemeral`
 * builds its text + keyboard.
 */

import type { InlineKeyboard } from 'grammy';
import type { WagerAsset } from '@calledit/market-engine';
import type { Deps, MarketRow } from '../ports.js';
import { miniAppPositionUrl } from './keyboards.js';
import { stakeStepperKeyboard } from './stake-step-keyboards.js';
import { sideLabelFor, stakeAmountLabel, stepperNote } from './stake-step-cards.js';
import { ladderAtomic, type StakeLadderCode } from '../wager/constants.js';

export interface StepperSurface {
  readonly text: string;
  readonly keyboard: InlineKeyboard;
}

function marketAsset(market: MarketRow): WagerAsset {
  return market.currency === 'usdc' ? 'usdc' : 'sol';
}

/**
 * The per-user ephemeral stepper (text + keyboard) for a market and rung. The
 * text is the short sizing note (current stake + base-stake anchor); the shared
 * card already carries the full compiled terms, so the ephemeral stays terse.
 * Escrow signs in the Mini App, so the sign button carries the current rung as a
 * direct-link URL (null → an in-chat signing callback fallback).
 */
export function renderStepperEphemeral(
  deps: Deps,
  market: MarketRow,
  side: 'back' | 'doubt',
  code: StakeLadderCode,
): StepperSurface {
  const asset = marketAsset(market);
  const custody = deps.env.WAGER_CUSTODY_MODE;
  const network = deps.env.SOLANA_NETWORK;
  const sideLabel = sideLabelFor(market.spec, side);
  const amountAtomic = ladderAtomic(asset, code);
  const amountLabel = stakeAmountLabel(amountAtomic, asset);
  const signUrl = custody === 'escrow' ? miniAppPositionUrl(market, side, code) : null;
  return {
    text: stepperNote(sideLabel, amountLabel),
    keyboard: stakeStepperKeyboard({
      marketId: market.id,
      side,
      code,
      asset,
      custody,
      network,
      signUrl,
    }),
  };
}

/**
 * Whether the card can currently accept new positions — mirrors the mint-time
 * and refresh-time computation (replay markets always, else the wager module's
 * global acceptance switch). Used to keep the stepper honest.
 */
export async function stakePositionsAvailable(deps: Deps, market: MarketRow): Promise<boolean> {
  const asset = marketAsset(market);
  return market.is_replay || (deps.wager !== null && (await deps.wager.stakesAvailable(asset)));
}
