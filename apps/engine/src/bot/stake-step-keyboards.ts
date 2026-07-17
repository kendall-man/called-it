/**
 * Two-step stake ladder keyboards (STAKE_LADDER_ENABLED). Step 1 (the two side
 * buttons) is unchanged — it stays the existing `st` offer keyboard so the
 * codec and the labels contract never fork. These builders are step 2 (the
 * value ladder) and the escrow sign handoff, both reachable only after a side
 * tap and both reversible via "← Back".
 *
 * Rungs are DISCRETE buttons (never a slider, never a stepper), ascending, with
 * the anchor 0.01 leftmost but never preselected. All callback payloads go
 * through the codec so every tap resolves to a DB row.
 */

import { InlineKeyboard } from 'grammy';
import type { WagerAsset } from '@calledit/market-engine';
import { encodeCallback } from './callbackData.js';
import { STAKE_BACK_LABEL, signButtonLabel } from './stake-step-cards.js';
import { stakeLadder } from '../wager/constants.js';
import { formatAssetAmount } from '../wager/format.js';
import type { SolanaNetwork } from '../solana-network.js';

/**
 * The value ladder: one row of ascending exact-amount rungs (escrow devnet
 * shows 0.01 / 0.02 / 0.05; legacy adds 0.1) plus a "← Back" row that re-opens
 * the two-side offer losslessly. No MAX, no %-of-wallet, no countdown.
 */
export function stakeLadderKeyboard(
  marketId: string,
  side: 'back' | 'doubt',
  asset: WagerAsset,
  custody: 'legacy' | 'escrow',
  network: SolanaNetwork,
): InlineKeyboard {
  const rungs = stakeLadder(asset, custody, network === 'mainnet-beta' ? 'mainnet-beta' : 'devnet');
  const keyboard = new InlineKeyboard();
  for (const rung of rungs) {
    keyboard.text(
      formatAssetAmount(rung.atomic, asset),
      encodeCallback({ t: 'stake_value', marketId, side, amountCode: rung.code }),
    );
  }
  keyboard.row().text(STAKE_BACK_LABEL, encodeCallback({ t: 'stake_back', marketId }));
  return keyboard;
}

/**
 * The escrow sign handoff: one URL button into the direct-link Mini App (the
 * amount + side are carried in the startapp param, no secret) plus "← Back" to
 * re-open the ladder. Nothing moves until the signature.
 */
export function stakeSignKeyboard(
  marketId: string,
  signUrl: string,
  amountAtomic: bigint,
  asset: WagerAsset,
  sideLabel: string,
): InlineKeyboard {
  return new InlineKeyboard()
    .url(signButtonLabel(formatAssetAmount(amountAtomic, asset), sideLabel), signUrl)
    .row()
    .text(STAKE_BACK_LABEL, encodeCallback({ t: 'stake_back', marketId }));
}
