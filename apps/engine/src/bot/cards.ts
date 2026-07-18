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

/**
 * Longest allowed side label BEFORE the " · 0.01 SOL" keyboard suffix. Keeps
 * every button label comfortably inside Telegram's visible width.
 */
const SIDE_LABEL_LIMIT = 22;

export interface SideLabels {
  back: string;
  doubt: string;
}

/** The exact binary fallback — the pre-pivot contract labels, kept verbatim. */
export const FALLBACK_SIDE_LABELS: SideLabels = { back: 'It happens', doubt: 'It does not' };

/**
 * Fit a name-bearing template inside SIDE_LABEL_LIMIT without mid-word cuts:
 * try the full compiled name, then its last word (surname / "United"), else
 * give up so the caller falls back to the binary labels.
 */
function fitEntityLabel(
  name: string,
  template: (entity: string) => string,
): string | null {
  const entity = normalizeInlineText(name, ENTITY_NAME_LIMIT, '');
  // A 96+-char name arrives truncated with an ellipsis — binary reads better.
  if (entity.length === 0 || entity.endsWith('...')) return null;
  const lastWord = entity.split(' ').at(-1);
  const candidates = lastWord === undefined || lastWord === entity
    ? [entity]
    : [entity, lastWord];
  for (const candidate of candidates) {
    const label = template(candidate);
    if (label.length <= SIDE_LABEL_LIMIT) return label;
  }
  return null;
}

function pairedSideLabels(back: string | null, doubt: string): SideLabels {
  return back === null ? FALLBACK_SIDE_LABELS : { back, doubt };
}

/**
 * Deterministic per-claim side labels, keyed on the compiled spec's claim
 * taxonomy and entity names — NEVER on LLM output. Anything without a clean
 * short subject (totals, non-gte comparators, overlong names) falls back to
 * the exact binary pair. Used verbatim by the offer keyboard, the card's side
 * lines, and the stake-confirmation prompt so the vocabulary never forks.
 */
export function sideLabels(spec: MarketSpec): SideLabels {
  switch (spec.claimType) {
    case 'match_winner':
      return pairedSideLabels(
        fitEntityLabel(spec.entityRef.name, (team) => `${team} to win`),
        'Draw or loss',
      );
    case 'comeback':
      return pairedSideLabels(
        fitEntityLabel(spec.entityRef.name, (team) => `${team} come back`),
        'No comeback',
      );
    case 'team_scores_n': {
      if (spec.comparator !== 'gte') return FALLBACK_SIDE_LABELS;
      const goals = spec.threshold === 1 ? ' score' : ` score ${spec.threshold}+`;
      return pairedSideLabels(
        fitEntityLabel(spec.entityRef.name, (team) => `${team}${goals}`),
        "They don't",
      );
    }
    case 'player_scores_n': {
      if (spec.comparator !== 'gte') return FALLBACK_SIDE_LABELS;
      const goals = spec.threshold === 1 ? ' scores' : ` scores ${spec.threshold}+`;
      return pairedSideLabels(
        fitEntityLabel(spec.entityRef.name, (player) => `${player}${goals}`),
        'No goal',
      );
    }
    case 'btts':
      return { back: 'Both teams score', doubt: "They don't" };
    case 'totals_ou':
      return FALLBACK_SIDE_LABELS;
  }
}

export function trustTierLine(tier: MarketSpec['trustTier']): string {
  return tier === 'chain_proven'
    ? 'Chain-proven. Merkle proof lands on the receipt page'
    : 'Oracle-resolved. Settled from the signed data feed';
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
      return `Call off. ${asset.toUpperCase()} returned`;
  }
}

/**
 * The 150s on-chain anti-snipe delay, rendered as one honest sentence while
 * finalized-but-pending escrow lots wait for activation. Uses the
 * escrowPlacementStatusText vocabulary (pending → activate).
 */
export const FAIR_PLAY_PENDING_LINE =
  'Fair-play check. New positions activate after a short delay.';

export interface SkeletonCardInput {
  quotedText: string;
  claimerName: string;
  isReplay: boolean;
}

/**
 * The card shell posted the instant the market row exists, before pricing
 * details and buttons are ready. The same message is later EDITED into the
 * full offer card (or a failure state), so the header lines must match
 * claimCardText exactly — the edit should read as the card filling in.
 */
export function skeletonCardText(input: SkeletonCardInput): string {
  const quote = normalizeInlineText(input.quotedText, QUOTED_TEXT_LIMIT, 'Call unavailable');
  const claimer = normalizeInlineText(input.claimerName, PERSON_NAME_LIMIT, 'the claimer');
  return telegramMessageBody([
    `🎙 THE CALL${input.isReplay ? ' · REPLAY' : ''}`,
    `“${quote}”, ${claimer}`,
    '',
    '⏳ Pricing this call off the live feed…',
  ].join('\n'));
}

/**
 * The very first surface for an explicit call under the single-message
 * lifecycle: a shell posted the instant the claim commits, before the parse
 * runs. Shares skeletonCardText's header so the later edit reads as the card
 * filling in.
 */
export function readingCardText(input: SkeletonCardInput): string {
  const quote = normalizeInlineText(input.quotedText, QUOTED_TEXT_LIMIT, 'Call unavailable');
  const claimer = normalizeInlineText(input.claimerName, PERSON_NAME_LIMIT, 'the claimer');
  return telegramMessageBody([
    `🎙 THE CALL${input.isReplay ? ' · REPLAY' : ''}`,
    `“${quote}”, ${claimer}`,
    '',
    '👀 Reading the call…',
  ].join('\n'));
}

/** One-line close edited into a claim's surface when its author declines. */
export const CLAIM_DECLINED_LINE = 'Declined. No SOL moved.';

/** One-line close edited into a claim's surface when its consent window lapses. */
export const CLAIM_EXPIRED_LINE = 'Call expired. No SOL moved.';

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
  /** Finalized-but-pending escrow lots still inside the fair-play delay. */
  readonly pendingActivationCount?: number;
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
  const sides = sideLabels(input.spec);
  const showsParticipants =
    input.backParticipants !== undefined || input.doubtParticipants !== undefined;
  const quote = normalizeInlineText(input.quotedText, QUOTED_TEXT_LIMIT, 'Call unavailable');
  const claimer = normalizeInlineText(input.claimerName, PERSON_NAME_LIMIT, 'the claimer');
  const lines = [
    `🎙 THE CALL${input.isReplay ? ' · REPLAY' : ''}`,
    `“${quote}”, ${claimer}`,
    '',
    `📋 ${describeTerms(input.spec)}`,
    `📈 Feed says ${formatProbabilityPct(input.probability)}%. Back pays ${backMult}, against ${againstMult} if matched (${provenanceChip(input.provenance)})`,
    `🚦 ${statusLine(input.status, currency)}`,
    ...(input.isReplay && input.custodyMode === 'escrow'
      ? [
          '🧪 Completed-match replay · No Points change',
          `🔐 On-chain escrow · ${escrowNetworkLabel(input.solanaNetwork ?? 'devnet')} · ${currency.toUpperCase()}`,
        ]
      : input.custodyMode === 'escrow'
        ? [`🔐 On-chain escrow · ${escrowNetworkLabel(input.solanaNetwork ?? 'devnet')} · ${currency.toUpperCase()}`]
        : []),
    ...(input.custodyMode === 'escrow' && (input.pendingActivationCount ?? 0) > 0
      ? [`⏳ ${FAIR_PLAY_PENDING_LINE}`]
      : []),
    ...(input.positionsAvailable === false
      ? [`⏸ New ${currency.toUpperCase()} positions are temporarily paused. No ${currency.toUpperCase()} can move.`]
      : []),
    '',
    `⚡ ${sides.back}: ${formatAssetAmount(input.back.stakeLamports, currency)} (${input.back.count} in)`,
    `🛑 ${sides.doubt}: ${formatAssetAmount(input.doubt.stakeLamports, currency)} (${input.doubt.count} in)`,
    `🤝 Matched: ${input.matchedPct}%`,
    ...(showsParticipants
      ? [
          `${sides.back}: ${sideListText(
            input.backParticipants ?? [],
            TELEGRAM_MESSAGE_LIMIT,
            input.backParticipantCount ?? input.backParticipants?.length ?? 0,
          )}`,
          `${sides.doubt}: ${sideListText(
            input.doubtParticipants ?? [],
            TELEGRAM_MESSAGE_LIMIT,
            input.doubtParticipantCount ?? input.doubtParticipants?.length ?? 0,
          )}`,
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
      return `CALLED IT. ${claimer} was right.`;
    case 'claim_lost':
      return `Not this time. The call goes down.`;
    case 'void':
      return `Call off. Every ${asset.toUpperCase()} position returned.`;
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
    `“${quote}”, ${claimer}`,
    '',
    `📋 ${describeTerms(input.spec)}`,
    `📈 Locked at the call: ${formatProbabilityPct(input.probability)}%. Back ${backMult}, against ${againstMult} (${provenanceChip(input.provenance)})`,
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

/** Escrow runtime health, collapsed to plain words for the group board. */
export type EscrowRuntimeStatusLabel =
  | 'ready'
  | 'rpc_unavailable'
  | 'indexer_lagging'
  | 'degraded';

/**
 * Collapse the in-process escrow readiness reasons to the one board label.
 * Raw reason codes never reach the chat — only these plain phrasings do.
 */
export function escrowRuntimeStatusLabel(report: {
  readonly status: 'ready' | 'not_ready';
  readonly reasons: readonly string[];
}): EscrowRuntimeStatusLabel {
  if (report.status === 'ready') return 'ready';
  if (report.reasons.includes('rpc_unavailable')) return 'rpc_unavailable';
  if (report.reasons.includes('indexer_lagging') || report.reasons.includes('indexer_unavailable')) {
    return 'indexer_lagging';
  }
  return 'degraded';
}

function escrowRuntimeStatusLine(label: EscrowRuntimeStatusLabel): string {
  switch (label) {
    case 'ready':
      return '🔐 Escrow desk: all clear';
    case 'rpc_unavailable':
      return '🔐 Escrow desk: chain connection catching up';
    case 'indexer_lagging':
      return '🔐 Escrow desk: receipts catching up';
    case 'degraded':
      return '🔐 Escrow desk: catching up';
  }
}

export interface StatusBoardInput {
  readonly feed:
    | { readonly kind: 'live' }
    | {
        readonly kind: 'replay';
        readonly fixtureLabel: string;
        readonly virtualMinute: number | null;
      };
  readonly openMarketCount: number;
  readonly pendingActivationCount: number;
  /** Omitted when the process runs without the escrow runtime. */
  readonly escrowRuntime?: EscrowRuntimeStatusLabel;
  readonly solanaNetwork: SolanaNetwork;
}

/**
 * The admin /status board: one compact message, aggregate numbers only, no
 * keyboard. Raw reason codes and anything user-identifying stay out.
 */
export function statusBoardText(input: StatusBoardInput): string {
  const feedLine = input.feed.kind === 'live'
    ? '📡 Feed: live matches'
    : `📡 Feed: completed-match replay of ${
      normalizeInlineText(input.feed.fixtureLabel, ENTITY_NAME_LIMIT, 'a finished match')
    }${input.feed.virtualMinute === null ? '' : ` · minute ${input.feed.virtualMinute}`}`;
  const lines = [
    '📟 STATUS',
    feedLine,
    `🎙 Open calls here: ${input.openMarketCount}`,
    `⏳ Positions in the fair-play wait: ${input.pendingActivationCount}`,
    ...(input.escrowRuntime === undefined
      ? []
      : [escrowRuntimeStatusLine(input.escrowRuntime)]),
    // Devnet needs no footer here — value disclaimers live at onboarding and
    // on the receipt page, not on routine boards. Mainnet stays explicit.
    ...(input.solanaNetwork === 'mainnet-beta'
      ? ['', 'SOL positions settle on Solana mainnet.']
      : []),
  ];
  return telegramMessageBody(lines.join('\n'));
}
