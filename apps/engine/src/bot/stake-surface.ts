/**
 * The single producer of the market card's surface (text + keyboard) for the
 * offer/compose states: offer_open and the n-step stepper. Callbacks, the
 * settler's refresh, and the projection sink all render through here so a
 * deferred passive edit re-renders the ACTIVE stepper state instead of stomping
 * it back to the two-side offer.
 *
 * With STAKE_LADDER_ENABLED off (or no active ui state), it returns exactly the
 * plain two-side offer surface the single-tap flow shows today.
 */

import type { InlineKeyboard } from 'grammy';
import type { WagerAsset } from '@calledit/market-engine';
import type { Deps, MarketRow } from '../ports.js';
import type { Poster } from './poster.js';
import { composeClaimCard } from '../pipeline/render.js';
import { composeTelegramMessage } from './message-budget.js';
import { marketStakeKeyboard, miniAppPositionUrl } from './keyboards.js';
import { stakeStepperKeyboard } from './stake-step-keyboards.js';
import { sideLabelFor, stakeAmountLabel, stepperNote } from './stake-step-cards.js';
import { ladderAtomic } from '../wager/constants.js';
import type { StakeUiState } from './stake-ui-state.js';

export interface CardSurface {
  readonly text: string;
  readonly keyboard: InlineKeyboard | undefined;
}

export interface RenderCardSurfaceOptions {
  readonly positionsAvailable: boolean;
  readonly ladderEnabled: boolean;
  /** The current two-step visual, or null for the plain offer / a closed market. */
  readonly uiState: StakeUiState | null;
}

function marketAsset(market: MarketRow): WagerAsset {
  return market.currency === 'usdc' ? 'usdc' : 'sol';
}

function isStakeableStatus(status: MarketRow['status']): boolean {
  return status === 'open' || status === 'pending_lineup';
}

export async function renderCardSurface(
  deps: Deps,
  market: MarketRow,
  options: RenderCardSurfaceOptions,
): Promise<CardSurface | null> {
  const card = await composeClaimCard(deps, market, {
    positionsAvailable: options.positionsAvailable,
  });
  if (card === null) return null;

  const stakeable = options.positionsAvailable && isStakeableStatus(market.status);
  if (!stakeable) {
    // Frozen / settled / paused surfaces carry no money actions.
    return { text: card.text, keyboard: undefined };
  }

  // Flag off, or nobody is mid-compose → the byte-for-byte two-side offer.
  if (!options.ladderEnabled || options.uiState === null) {
    return { text: card.text, keyboard: marketStakeKeyboard(deps, market) };
  }

  const uiState = options.uiState;
  const asset = marketAsset(market);
  const custody = deps.env.WAGER_CUSTODY_MODE;
  const network = deps.env.SOLANA_NETWORK;
  const sideLabel = sideLabelFor(market.spec, uiState.side);
  const amountAtomic = ladderAtomic(asset, uiState.code);
  const amountLabel = stakeAmountLabel(amountAtomic, asset);
  // Escrow signs in the Mini App; the URL carries the current rung and updates
  // as the member steps. Null (Mini App unconfigured) drops to a signing
  // callback in the keyboard, so the surface never strands on a dead handoff.
  const signUrl = custody === 'escrow' ? miniAppPositionUrl(market, uiState.side, uiState.code) : null;
  return {
    text: composeTelegramMessage({ body: card.text, note: stepperNote(sideLabel, amountLabel) }),
    keyboard: stakeStepperKeyboard({
      marketId: market.id,
      side: uiState.side,
      code: uiState.code,
      asset,
      custody,
      network,
      sideLabel,
      signUrl,
    }),
  };
}

/**
 * Whether the card can currently accept new positions — mirrors the mint-time
 * and refresh-time computation (replay markets always, else the wager module's
 * global acceptance switch). Used to keep the two-step surface honest.
 */
export async function stakePositionsAvailable(deps: Deps, market: MarketRow): Promise<boolean> {
  const asset = marketAsset(market);
  return market.is_replay || (deps.wager !== null && (await deps.wager.stakesAvailable(asset)));
}

/**
 * Render and edit the market card to its current surface. Shared by the two-step
 * callbacks and the auto-revert timer so every surface change flows through one
 * renderer (a deferred passive edit re-renders the active state, not the offer).
 */
export async function editCardSurface(
  deps: Deps,
  poster: Poster,
  market: MarketRow,
  options: RenderCardSurfaceOptions,
  editOptions?: { readonly urgent?: boolean },
): Promise<void> {
  if (market.card_tg_message_id === null) return;
  const surface = await renderCardSurface(deps, market, options);
  if (surface === null) return;
  poster.editCard(
    market.group_id,
    market.id,
    market.card_tg_message_id,
    surface.text,
    surface.keyboard,
    editOptions ?? {},
  );
}
