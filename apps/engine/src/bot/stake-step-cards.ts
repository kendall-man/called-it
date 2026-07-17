/**
 * Two-step stake ladder copy (STAKE_LADDER_ENABLED). Pure string builders for
 * the states the offer card evolves through while a member composes a stake:
 * value_pick (a side is chosen, a size is not) and sign_handoff (escrow, a size
 * is chosen, the signature is not). All deterministic — side labels come from
 * the compiled spec via cards.ts (imported read-only), amounts from the wager
 * formatter. No LLM text, no numbers invented here.
 *
 * Voice: facilitator, terse, confident. No urgency, hype, or re-stake prompt;
 * zero exclamation marks in money lines; "← Back" carries no suffix; 0.01 is
 * named the "base stake" (the anchor is position + copy, never preselection);
 * no devnet value nag (disclosed once at onboarding + receipt, per the copy
 * contract).
 */

import type { MarketSpec, SettlementOutcome, WagerAsset } from '@calledit/market-engine';
import { sideLabels } from './cards.js';
import { formatAssetAmount } from '../wager/format.js';

/** "← Back" — lossless return to the two-side offer. No suffix (copy rule). */
export const STAKE_BACK_LABEL = '← Back';

const BASE_STAKE_NOTE = '0.01 is the base stake. Nothing moves until you sign.';

/** The compiled per-claim label for a side (deterministic, never LLM text). */
export function sideLabelFor(spec: MarketSpec, side: 'back' | 'doubt'): string {
  const labels = sideLabels(spec);
  return side === 'back' ? labels.back : labels.doubt;
}

/**
 * Endowed-progress block with REAL completed steps: the price and side are
 * done, the size (and for escrow, the signature) is what remains. `step`
 * distinguishes the value_pick card from the sign_handoff card.
 */
export function stakeProgressBlock(step: 'value' | 'sign', sideLabel: string): string {
  const stakeMark = step === 'value' ? '⬜ Stake · choose a size' : '✅ Stake · sized';
  return `✅ Priced   ✅ Side · ${sideLabel}   ${stakeMark}`;
}

/**
 * State 5 (value_pick) body appended to the offer card. Names the base stake
 * anchor by copy; the ladder rungs live on the keyboard.
 */
export function valuePickBody(sideLabel: string): string {
  return [stakeProgressBlock('value', sideLabel), BASE_STAKE_NOTE].join('\n');
}

/** Amount rendering shared by the sign body and the sign button. */
export function stakeAmountLabel(amountAtomic: bigint, asset: WagerAsset): string {
  return formatAssetAmount(amountAtomic, asset);
}

/**
 * State 6 (sign_handoff, escrow) body appended to the offer card once a rung is
 * picked. The only exit is the Mini App URL button; a "← Back" button re-opens
 * the ladder.
 */
export function signHandoffBody(sideLabel: string, amountLabel: string): string {
  return [
    stakeProgressBlock('sign', sideLabel),
    `Review and sign ${amountLabel} for ${sideLabel} in the wallet. Nothing moves until you sign.`,
  ].join('\n');
}

/** URL-button label for the sign handoff. Full-width, so a little longer is fine. */
export function signButtonLabel(amountLabel: string, sideLabel: string): string {
  return `Review & sign ${amountLabel} for ${sideLabel}`;
}

/**
 * State 8 ping: the single compact notification that replies to the card when
 * a market settles (card edits emit no notification, so one ping is justified).
 * Compact, no hype, no re-stake prompt — the full board lives on the card.
 */
export function settlementPingText(outcome: SettlementOutcome, receiptUrl: string): string {
  const head =
    outcome === 'claim_won'
      ? 'Called it — settled.'
      : outcome === 'claim_lost'
        ? 'Settled — the call goes down.'
        : 'Call off — positions returned.';
  return `${head} Board and receipt: ${receiptUrl}`;
}
