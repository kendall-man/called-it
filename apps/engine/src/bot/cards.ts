/**
 * Text-first card composition (OG images are cut per PRD cut order).
 * Pure string builders — persona garnish lines are passed in by callers so
 * this module stays deterministic and testable.
 */

import type { MarketSpec, MarketStatus, SettlementOutcome } from '@calledit/market-engine';

export function formatRep(amount: number): string {
  return amount.toLocaleString('en-US');
}

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
    ? 'Chain-proven — Merkle proof lands on the receipt page'
    : 'Oracle-resolved — settled from the signed data feed';
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
      return 'Call off — Rep returned';
  }
}

export interface SideTally {
  count: number;
  totalRep: number;
}

export interface ClaimCardInput {
  quotedText: string;
  claimerName: string;
  spec: MarketSpec;
  status: MarketStatus;
  probability: number;
  multiplier: number;
  provenance: 'market' | 'modelled';
  back: SideTally;
  doubt: SideTally;
  isReplay: boolean;
  receiptUrl: string;
  tableUrl: string;
  /** Set only for sol markets (wager module cardFooter) — Rep cards never carry one. */
  footer?: string;
}

export function claimCardText(input: ClaimCardInput): string {
  const lines = [
    `🎙 THE CALL${input.isReplay ? ' · REPLAY' : ''}`,
    `“${input.quotedText}” — ${input.claimerName}`,
    '',
    `📋 ${describeTerms(input.spec)}`,
    `📈 Data says ${formatProbabilityPct(input.probability)}% → ${formatMultiplier(input.multiplier)} Rep (${provenanceChip(input.provenance)})`,
    `🚦 ${statusLine(input.status)}`,
    '',
    `⚡ Backing: ${input.back.count} in · ${formatRep(input.back.totalRep)} Rep on the line`,
    `🛑 Doubting: ${input.doubt.count} in · ${formatRep(input.doubt.totalRep)} Rep on the line`,
    '',
    `Receipt: ${input.receiptUrl}`,
    `Table: ${input.tableUrl}`,
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
  multiplier: number;
  provenance: 'market' | 'modelled';
  payoutsLine: string;
  isReplay: boolean;
  receiptUrl: string;
}

export function outcomeLine(outcome: SettlementOutcome, claimerName: string): string {
  switch (outcome) {
    case 'claim_won':
      return `CALLED IT — ${claimerName} was right.`;
    case 'claim_lost':
      return `Not this time — the call goes down.`;
    case 'void':
      return `Call off — everyone's Rep returned.`;
  }
}

export function receiptCardText(input: ReceiptCardInput): string {
  const lines = [
    `🧾 RECEIPT${input.isReplay ? ' · REPLAY' : ''}`,
    `“${input.quotedText}” — ${input.claimerName}`,
    '',
    `📋 ${describeTerms(input.spec)}`,
    `📈 Price at the call: ${formatProbabilityPct(input.probability)}% → ${formatMultiplier(input.multiplier)} Rep (${provenanceChip(input.provenance)})`,
    `🏁 ${outcomeLine(input.outcome, input.claimerName)}`,
  ];
  if (input.payoutsLine.length > 0) lines.push(`💠 ${input.payoutsLine}`);
  lines.push(`🔏 ${trustTierLine(input.spec.trustTier)}`, '', `Receipt: ${input.receiptUrl}`);
  return lines.join('\n');
}
