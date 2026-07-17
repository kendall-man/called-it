/**
 * The single producer of the market card's surface (text + keyboard) for the
 * offer/compose states (4-7): offer_open, value_pick, sign_handoff. Callbacks,
 * the settler's refresh, and the projection sink all render through here so a
 * deferred passive edit re-renders the ACTIVE two-step state instead of
 * stomping it back to the two-side offer.
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
import { stakeLadderKeyboard, stakeSignKeyboard } from './stake-step-keyboards.js';
import {
  sideLabelFor,
  signHandoffBody,
  stakeAmountLabel,
  valuePickBody,
} from './stake-step-cards.js';
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

  const ladderSurface = (): CardSurface => ({
    text: composeTelegramMessage({ body: card.text, note: valuePickBody(sideLabel) }),
    keyboard: stakeLadderKeyboard(market.id, uiState.side, asset, custody, network),
  });

  if (uiState.kind === 'ladder') return ladderSurface();

  // sign_handoff (escrow): the Mini App URL button carries the chosen amount.
  const amountAtomic = ladderAtomic(asset, uiState.amountCode);
  const url = miniAppPositionUrl(market, uiState.side, uiState.amountCode);
  if (url === null) {
    // The Mini App is not configured — never strand the surface on a dead
    // handoff; fall back to the ladder so the member can still pick again.
    return ladderSurface();
  }
  return {
    text: composeTelegramMessage({
      body: card.text,
      note: signHandoffBody(sideLabel, stakeAmountLabel(amountAtomic, asset)),
    }),
    keyboard: stakeSignKeyboard(market.id, url, amountAtomic, asset, sideLabel),
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
