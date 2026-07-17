/**
 * Text-first card composition (OG images are cut per PRD cut order).
 * Pure string builders — persona garnish lines are passed in by callers so
 * this module stays deterministic and testable.
 */

import type {
  MarketSpec,
  MarketStatus,
  SettlementOutcome,
  WagerAsset,
} from '@calledit/market-engine';
import {
  normalizeInlineText,
  telegramMessageBody,
} from './message-budget.js';
import {
  leaderboardText,
  settlementPointsText,
  sideListText,
  TELEGRAM_MESSAGE_LIMIT,
  type LeaderboardPlayer,
  type ParticipantIdentity,
} from '../points/presentation.js';
import { formatAssetAmount } from '../wager/format.js';
import { fullMatchMultiplier } from '../wager/pot.js';
import type { SolanaNetwork } from '../solana-network.js';
import { escrowNetworkLabel, publicEscrowActionUrl } from './escrow-ux.js';

const QUOTED_TEXT_LIMIT = 512;
const PERSON_NAME_LIMIT = 64;
const ENTITY_NAME_LIMIT = 96;

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
  const entity = normalizeInlineText(spec.entityRef.name, ENTITY_NAME_LIMIT, 'the selection');
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

export function statusLine(status: MarketStatus, asset: WagerAsset = 'sol'): string {
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
      return `Call off — ${asset.toUpperCase()} returned`;
  }
}

/** Per-side card tally: how many bettors and the pooled stake in lamports. */
export interface SideTally {
  count: number;
  stakeLamports: bigint;
}

export interface ClaimCardInput {
  /** Omitted only by legacy SOL fixtures. Persisted markets always set it. */
  currency?: WagerAsset;
  quotedText: string;
  claimerName: string;
  spec: MarketSpec;
  status: MarketStatus;
  probability: number;
  provenance: 'market' | 'modelled';
  back: SideTally;
  doubt: SideTally;
  readonly backParticipants?: readonly ParticipantIdentity[];
  readonly doubtParticipants?: readonly ParticipantIdentity[];
  readonly backParticipantCount?: number;
  readonly doubtParticipantCount?: number;
  /** 0..100 — matched fraction of the total staked pot. */
  matchedPct: number;
  isReplay: boolean;
  readonly custodyMode?: 'legacy' | 'escrow';
  readonly solanaNetwork?: SolanaNetwork;
  receiptUrl: string;
  /** False when a rollout or solvency gate has paused new positions. */
  positionsAvailable?: boolean;
  /** Set by the wager module cardFooter — the devnet-SOL disclosure. */
  footer?: string;
}

export function claimCardText(input: ClaimCardInput): string {
  const currency = input.currency ?? 'sol';
  const backMult = formatMultiplier(fullMatchMultiplier(input.probability, 'back'));
  const againstMult = formatMultiplier(fullMatchMultiplier(input.probability, 'doubt'));
  const showsParticipants =
    input.backParticipants !== undefined || input.doubtParticipants !== undefined;
  const quote = normalizeInlineText(input.quotedText, QUOTED_TEXT_LIMIT, 'Call unavailable');
  const claimer = normalizeInlineText(input.claimerName, PERSON_NAME_LIMIT, 'the claimer');
  const lines = [
    `🎙 THE CALL${input.isReplay ? ' · REPLAY' : ''}`,
    `“${quote}” — ${claimer}`,
    '',
    `📋 ${describeTerms(input.spec)}`,
    `📈 Feed says ${formatProbabilityPct(input.probability)}% — back pays ${backMult}, against ${againstMult} if matched (${provenanceChip(input.provenance)})`,
    `🚦 ${statusLine(input.status, currency)}`,
    ...(input.isReplay && input.custodyMode === 'escrow'
      ? [
          '🧪 Completed-match replay · No Points change',
          `🔐 On-chain escrow · ${escrowNetworkLabel(input.solanaNetwork ?? 'devnet')} · ${currency.toUpperCase()}`,
        ]
      : input.custodyMode === 'escrow'
        ? [`🔐 On-chain escrow · ${escrowNetworkLabel(input.solanaNetwork ?? 'devnet')} · ${currency.toUpperCase()}`]
        : []),
    ...(input.positionsAvailable === false
      ? [`⏸ New ${currency.toUpperCase()} positions are temporarily paused. No ${currency.toUpperCase()} can move.`]
      : []),
    '',
    `⚡ Backing it: ${formatAssetAmount(input.back.stakeLamports, currency)} (${input.back.count} in)`,
    `🛑 Against it: ${formatAssetAmount(input.doubt.stakeLamports, currency)} (${input.doubt.count} in)`,
    `🤝 Matched: ${input.matchedPct}%`,
    ...(showsParticipants
      ? [
          `It happens: ${sideListText(
            input.backParticipants ?? [],
            TELEGRAM_MESSAGE_LIMIT,
            input.backParticipantCount ?? input.backParticipants?.length ?? 0,
          )}`,
          `It does not: ${sideListText(
            input.doubtParticipants ?? [],
            TELEGRAM_MESSAGE_LIMIT,
            input.doubtParticipantCount ?? input.doubtParticipants?.length ?? 0,
          )}`,
          'Choices and results are visible in this group.',
        ]
      : []),
    '',
    `Receipt: ${input.receiptUrl}`,
  ];
  if (input.footer !== undefined && input.footer.length > 0) lines.push('', input.footer);
  return telegramMessageBody(lines.join('\n'));
}

export interface ReceiptCardInput {
  currency?: WagerAsset;
  quotedText: string;
  claimerName: string;
  spec: MarketSpec;
  outcome: SettlementOutcome;
  probability: number;
  provenance: 'market' | 'modelled';
  payoutsLine: string;
  isReplay: boolean;
  readonly custodyMode?: 'legacy' | 'escrow';
  readonly solanaNetwork?: SolanaNetwork;
  /** Public explorer URL only. Private signing/claim links never belong in group receipts. */
  readonly transactionUrl?: string;
  receiptUrl: string;
  readonly points?: {
    readonly winnerCount: number;
    readonly missCount: number;
    readonly winners: readonly ParticipantIdentity[];
    readonly misses: readonly ParticipantIdentity[];
    readonly leaderboard: readonly LeaderboardPlayer[];
  };
}

export function outcomeLine(
  outcome: SettlementOutcome,
  claimerName: string,
  asset: WagerAsset = 'sol',
): string {
  const claimer = normalizeInlineText(claimerName, PERSON_NAME_LIMIT, 'the claimer');
  switch (outcome) {
    case 'claim_won':
      return `CALLED IT — ${claimer} was right.`;
    case 'claim_lost':
      return `Not this time — the call goes down.`;
    case 'void':
      return `Call off — every ${asset.toUpperCase()} position returned.`;
  }
}

export function receiptCardText(input: ReceiptCardInput): string {
  const currency = input.currency ?? 'sol';
  const backMult = formatMultiplier(fullMatchMultiplier(input.probability, 'back'));
  const againstMult = formatMultiplier(fullMatchMultiplier(input.probability, 'doubt'));
  const quote = normalizeInlineText(input.quotedText, QUOTED_TEXT_LIMIT, 'Call unavailable');
  const claimer = normalizeInlineText(input.claimerName, PERSON_NAME_LIMIT, 'the claimer');
  const lines = [
    `🧾 RECEIPT${input.isReplay ? ' · REPLAY' : ''}`,
    `“${quote}” — ${claimer}`,
    '',
    `📋 ${describeTerms(input.spec)}`,
    `📈 Locked at the call: ${formatProbabilityPct(input.probability)}% — back ${backMult}, against ${againstMult} (${provenanceChip(input.provenance)})`,
    `🏁 ${outcomeLine(input.outcome, input.claimerName, currency)}`,
  ];
  if (input.isReplay && input.custodyMode === 'escrow') {
    lines.push(
      '🧪 Completed-match replay · No Points changed',
      `🔐 On-chain escrow · ${escrowNetworkLabel(input.solanaNetwork ?? 'devnet')} · ${currency.toUpperCase()}`,
    );
  } else if (input.custodyMode === 'escrow') {
    lines.push(`🔐 On-chain escrow · ${escrowNetworkLabel(input.solanaNetwork ?? 'devnet')} · ${currency.toUpperCase()}`);
  }
  if (input.payoutsLine.length > 0) lines.push(`💠 ${input.payoutsLine}`);
  lines.push(`🔏 ${trustTierLine(input.spec.trustTier)}`);
  const pointsAllowed = !(input.isReplay && input.custodyMode === 'escrow');
  if (pointsAllowed && input.points !== undefined && input.outcome !== 'void') {
    const settlement = settlementPointsText(input.points, TELEGRAM_MESSAGE_LIMIT);
    if (settlement.length > 0) lines.push('', settlement);
    lines.push(
      '',
      leaderboardText({ entries: input.points.leaderboard, limit: 5 }, TELEGRAM_MESSAGE_LIMIT),
    );
  }
  const transactionUrl = publicEscrowActionUrl(input.transactionUrl);
  if (transactionUrl !== null) lines.push('', `Transaction: ${transactionUrl}`);
  lines.push('', `Receipt: ${input.receiptUrl}`);
  return telegramMessageBody(lines.join('\n'));
}
