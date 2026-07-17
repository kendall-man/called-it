/**
 * Text-first card composition (OG images are cut per PRD cut order).
 * Pure string builders — persona garnish lines are passed in by callers so
 * this module stays deterministic and testable.
 */

import type { MarketSpec, MarketStatus, SettlementOutcome } from '@calledit/market-engine';
import { formatSolAmount } from '../wager/format.js';
import { fullMatchMultiplier } from '../wager/pot.js';

/** ×9 for big numbers, one decimal below 10 (×2.5), never odds notation. */
export function formatMultiplier(multiplier: number): string {
  const rounded = multiplier >= 10 ? Math.round(multiplier) : Math.round(multiplier * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `×${text}`;
}

export function formatProbabilityPct(probability: number): string {
  const pct = probability * 100;
  if (pct > 0 && pct < 1) return '<1';
  if (pct > 99 && pct < 100) return '>99';
  return String(Math.round(pct));
}

function periodPhrase(spec: MarketSpec): string {
  return spec.period === 'FT_90' ? 'in 90 minutes' : 'including extra time and pens if it goes there';
}

function thresholdPhrase(comparator: MarketSpec['comparator'], threshold: number): string {
  switch (comparator) {
    case 'gte':
      return `${threshold} or more`;
    case 'lte':
      return `${threshold} or fewer`;
    case 'eq':
      return `exactly ${threshold}`;
  }
}

/** Plain-English terms derived from the compiled spec — the receipt's promise. */
export function describeTerms(spec: MarketSpec): string {
  const entity = spec.entityRef.name;
  switch (spec.claimType) {
    case 'match_winner':
      return `${entity} to win (${periodPhrase(spec)})`;
    case 'totals_ou':
      return `${thresholdPhrase(spec.comparator, spec.threshold)} goals in the match (${periodPhrase(spec)})`;
    case 'team_scores_n':
      return `${entity} to score ${thresholdPhrase(spec.comparator, spec.threshold)} goals (${periodPhrase(spec)})`;
    case 'btts':
      return `both teams to score (${periodPhrase(spec)})`;
    case 'player_scores_n':
      return `${entity} to score ${thresholdPhrase(spec.comparator, spec.threshold)} goals (${periodPhrase(spec)})`;
    case 'comeback': {
      const anchor = spec.anchor;
      const from = anchor ? ` from ${anchor.scoreP1}-${anchor.scoreP2} down` : '';
      return `${entity} to turn it around and win${from} (${periodPhrase(spec)})`;
    }
  }
}

export function provenanceChip(provenance: 'market' | 'modelled'): string {
  return provenance === 'market' ? 'market price' : 'modelled price';
}

export function trustTierLine(tier: MarketSpec['trustTier']): string {
  return tier === 'chain_proven'
    ? 'Chain-proven: Merkle-verified against the on-chain root'
    : 'Oracle-resolved: settled from the signed data feed';
}

export function statusLine(status: MarketStatus): string {
  switch (status) {
    case 'pending_lineup':
      return 'Waiting on lineups';
    case 'open':
      return 'Calls open';
    case 'frozen':
      return 'Calls locked';
    case 'settling':
      return 'Judges are checking';
    case 'settled':
      return 'Settled';
    case 'voided':
      return 'Call off, SOL returned';
  }
}

/** Per-side card tally: how many bettors and the pooled stake in lamports. */
export interface SideTally {
  count: number;
  stakeLamports: bigint;
}

export interface ClaimCardInput {
  quotedText: string;
  claimerName: string;
  spec: MarketSpec;
  status: MarketStatus;
  probability: number;
  provenance: 'market' | 'modelled';
  back: SideTally;
  doubt: SideTally;
  /** 0..100 — matched fraction of the total staked pot. */
  matchedPct: number;
  /** Kept for settlement semantics; the demo card renders every match as live. */
  isReplay: boolean;
  /** Set by the wager module cardFooter — the devnet-SOL disclosure. */
  footer?: string;
}

export function claimCardText(input: ClaimCardInput): string {
  const backMult = formatMultiplier(fullMatchMultiplier(input.probability, 'back'));
  const againstMult = formatMultiplier(fullMatchMultiplier(input.probability, 'doubt'));
  const lines = [
    `🎙 THE CALL from ${input.claimerName}`,
    `“${input.quotedText}”`,
    '',
    `📋 ${describeTerms(input.spec)}`,
    `📈 Feed says ${formatProbabilityPct(input.probability)}%: back pays ${backMult}, against ${againstMult} if matched (${provenanceChip(input.provenance)})`,
    `🚦 ${statusLine(input.status)}`,
    '',
    `⚡ Backing it: ${formatSolAmount(input.back.stakeLamports)} (${input.back.count} in)`,
    `🛑 Against it: ${formatSolAmount(input.doubt.stakeLamports)} (${input.doubt.count} in)`,
    `🤝 Matched: ${input.matchedPct}%`,
  ];
  if (input.footer !== undefined && input.footer.length > 0) lines.push('', input.footer);
  return lines.join('\n');
}

export interface ReceiptCardInput {
  quotedText: string;
  claimerName: string;
  spec: MarketSpec;
  outcome: SettlementOutcome;
  probability: number;
  provenance: 'market' | 'modelled';
  payoutsLine: string;
  /** Kept for settlement semantics; the demo card renders every match as live. */
  isReplay: boolean;
}

export function outcomeLine(outcome: SettlementOutcome, claimerName: string): string {
  switch (outcome) {
    case 'claim_won':
      return `CALLED IT. ${claimerName} was right.`;
    case 'claim_lost':
      return `Not this time. The call goes down.`;
    case 'void':
      return `Call off. Every SOL stake returned.`;
  }
}

/** The full-time settlement card (historically the "receipt card"). */
export function receiptCardText(input: ReceiptCardInput): string {
  const backMult = formatMultiplier(fullMatchMultiplier(input.probability, 'back'));
  const againstMult = formatMultiplier(fullMatchMultiplier(input.probability, 'doubt'));
  const lines = [
    `🏁 SETTLED`,
    `“${input.quotedText}”, called by ${input.claimerName}`,
    '',
    `📋 ${describeTerms(input.spec)}`,
    `📈 Locked at the call: ${formatProbabilityPct(input.probability)}%, back ${backMult}, against ${againstMult} (${provenanceChip(input.provenance)})`,
    `🎯 ${outcomeLine(input.outcome, input.claimerName)}`,
  ];
  if (input.payoutsLine.length > 0) lines.push(`💠 ${input.payoutsLine}`);
  lines.push(`🔏 ${trustTierLine(input.spec.trustTier)}`);
  return lines.join('\n');
}
