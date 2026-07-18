/**
 * N-step stepper keyboard (STAKE_LADDER_ENABLED). Step 1 (the two side buttons)
 * is unchanged — it stays the existing `st` offer keyboard so the codec and the
 * labels contract never fork. This builder is step 2: a small editable card that
 * a member dials up/down, reachable only after a side tap and reversible via
 * "← Back".
 *
 * Rows:
 *   1. Amount row — `[−]  0.02 SOL  [+]`. Each button carries the rung it lands
 *      on (a `stake_step` tap moves ZERO SOL); `−` is omitted at the base rung
 *      (0.01), `+` at the effective cap. The middle amount is an idempotent
 *      step, so tapping it just keeps the surface alive.
 *   2. Action row — escrow shows a Mini App URL button ("Review & sign …"), or,
 *      when the Mini App URL is unavailable, an escrow-signing callback; legacy
 *      shows a "Confirm <amount>" callback. Nothing commits before this tap.
 *   3. Back row — a lossless "← Back" to the two-side offer.
 *
 * The anchor 0.01 is entered by position and copy, never preselected higher.
 */

import { InlineKeyboard } from 'grammy';
import type { WagerAsset } from '@calledit/market-engine';
import { encodeCallback } from './callbackData.js';
import {
  confirmButtonLabel,
  signButtonLabel,
  STAKE_BACK_LABEL,
  STAKE_STEP_DOWN_LABEL,
  STAKE_STEP_UP_LABEL,
} from './stake-step-cards.js';
import { ladderAtomic, stakeLadder, type StakeLadderCode } from '../wager/constants.js';
import { formatAssetAmount } from '../wager/format.js';
import type { SolanaNetwork } from '../solana-network.js';

export interface StakeStepperKeyboardInput {
  readonly marketId: string;
  readonly side: 'back' | 'doubt';
  /** The rung currently shown (base units of 0.01 of the asset). */
  readonly code: StakeLadderCode;
  readonly asset: WagerAsset;
  readonly custody: 'legacy' | 'escrow';
  readonly network: SolanaNetwork;
  /**
   * The direct-link Mini App signing URL for the current rung (escrow only),
   * or null. Null with escrow custody falls back to a signing callback so the
   * surface never strands on a dead handoff.
   */
  readonly signUrl: string | null;
}

/**
 * The small editable stepper card. `stake_step` re-sizes without moving SOL;
 * the explicit action row (`stake_value` callback or the Mini App URL) is the
 * only commit.
 */
export function stakeStepperKeyboard(input: StakeStepperKeyboardInput): InlineKeyboard {
  const network = input.network === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  const rungs = stakeLadder(input.asset, input.custody, network);
  const currentIndex = rungs.findIndex((rung) => rung.code === input.code);
  // A code off the ladder should never reach here (callbacks validate first);
  // clamp defensively so the stepper still renders a coherent row.
  const index = currentIndex < 0 ? 0 : currentIndex;
  const current = rungs[index] ?? rungs[0];
  const currentAtomic = current !== undefined ? current.atomic : ladderAtomic(input.asset, input.code);
  const amountLabel = formatAssetAmount(currentAtomic, input.asset);

  const keyboard = new InlineKeyboard();

  // Amount row: [−] amount [+]. Omit − at the base rung, + at the cap.
  const previous = index > 0 ? rungs[index - 1] : undefined;
  const next = index < rungs.length - 1 ? rungs[index + 1] : undefined;
  if (previous !== undefined) {
    keyboard.text(
      STAKE_STEP_DOWN_LABEL,
      encodeCallback({ t: 'stake_step', marketId: input.marketId, side: input.side, amountCode: previous.code }),
    );
  }
  keyboard.text(
    amountLabel,
    encodeCallback({ t: 'stake_step', marketId: input.marketId, side: input.side, amountCode: input.code }),
  );
  if (next !== undefined) {
    keyboard.text(
      STAKE_STEP_UP_LABEL,
      encodeCallback({ t: 'stake_step', marketId: input.marketId, side: input.side, amountCode: next.code }),
    );
  }

  // Action row: sign (escrow) or confirm (legacy/replay).
  keyboard.row();
  const actionLabel = input.custody === 'escrow'
    ? signButtonLabel(amountLabel)
    : confirmButtonLabel(amountLabel);
  if (input.signUrl !== null) {
    keyboard.url(actionLabel, input.signUrl);
  } else {
    keyboard.text(
      actionLabel,
      encodeCallback({ t: 'stake_value', marketId: input.marketId, side: input.side, amountCode: input.code }),
    );
  }

  // Back row: lossless return to the two-side offer.
  keyboard.row().text(STAKE_BACK_LABEL, encodeCallback({ t: 'stake_back', marketId: input.marketId }));
  return keyboard;
}
