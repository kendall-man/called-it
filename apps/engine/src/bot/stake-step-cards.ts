/**
 * N-step stepper copy (STAKE_LADDER_ENABLED). Pure string builders for the
 * small editable card the offer evolves into while a member sizes a stake:
 * a −/amount/+ stepper plus one sign-or-confirm action. All deterministic —
 * side labels come from the compiled spec via cards.ts (imported read-only),
 * amounts from the wager formatter. No LLM text, no numbers invented here.
 *
 * Voice: facilitator, terse, confident. No urgency, hype, or re-stake prompt;
 * zero exclamation marks in money lines; "← Back" carries no suffix; 0.01 is
 * named the "base stake" (the anchor is position + copy, never preselection);
 * no devnet value nag (disclosed once at onboarding + receipt, per the copy
 * contract). Less is more: the note stays to two short lines.
 */

import type { MarketSpec, SettlementOutcome, WagerAsset } from '@calledit/market-engine';
import { sideLabels } from './cards.js';
import { formatAssetAmount } from '../wager/format.js';

/** "← Back" — lossless return to the two-side offer. No suffix (copy rule). */
export const STAKE_BACK_LABEL = '← Back';

/** Step-down / step-up glyphs (real minus sign, U+2212) for the amount row. */
export const STAKE_STEP_DOWN_LABEL = '−';
export const STAKE_STEP_UP_LABEL = '+';

const BASE_STAKE_NOTE = '0.01 is the base stake. Nothing moves until you sign.';

/**
 * The one-line the per-user ephemeral stepper collapses to on Back, on commit,
 * or when its sizing window lapses. Terse, no urgency, no re-stake prompt; the
 * shared card still carries the two side buttons for another try.
 */
export const STEPPER_CLOSED_LINE = 'Closed. Tap a side on the card to size again.';

/** The compiled per-claim label for a side (deterministic, never LLM text). */
export function sideLabelFor(spec: MarketSpec, side: 'back' | 'doubt'): string {
  const labels = sideLabels(spec);
  return side === 'back' ? labels.back : labels.doubt;
}

/** Amount rendering shared by the note, the amount button, and the actions. */
export function stakeAmountLabel(amountAtomic: bigint, asset: WagerAsset): string {
  return formatAssetAmount(amountAtomic, asset);
}

/**
 * The small stepper note appended to the offer card: the current stake and the
 * base-stake anchor. The compiled terms line already lives in the card body, so
 * this stays to two short lines (less is more).
 */
export function stepperNote(sideLabel: string, amountLabel: string): string {
  return [`Sizing ${sideLabel} · ${amountLabel}`, BASE_STAKE_NOTE].join('\n');
}

/** Full-width escrow action: dial down/up, then sign the shown amount. */
export function signButtonLabel(amountLabel: string, sideLabel: string): string {
  return `Review & sign ${amountLabel} for ${sideLabel}`;
}

/** Full-width legacy/replay action: commit the shown amount. No exclamation. */
export function confirmButtonLabel(amountLabel: string): string {
  return `Confirm ${amountLabel}`;
}

/**
 * State 8 ping: the single compact notification that replies to the card when
 * a market settles (card edits emit no notification, so one ping is justified).
 * Compact, no hype, no re-stake prompt — the full board lives on the card.
 */
export function settlementPingText(outcome: SettlementOutcome, receiptUrl: string): string {
  const head =
    outcome === 'claim_won'
      ? 'Called it. Settled.'
      : outcome === 'claim_lost'
        ? 'Settled. The call goes down.'
        : 'Call off. Positions returned.';
  return `${head} Board and receipt: ${receiptUrl}`;
}
