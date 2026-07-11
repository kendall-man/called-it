/**
 * Row shapes for the curated public_* views
 * plus pure mapping helpers shared by server pages and the live trust badge.
 *
 * public_receipts selects one deterministic proof row in SQL, so every public
 * market maps to exactly one receipt row. Raw claims, user identities,
 * wallets, replay flags, and private balances never cross this mapper.
 */
import { describePeriod, describeTerms, parseMarketSpec } from './spec-terms';

export type ReceiptStatus =
  | 'pending_lineup'
  | 'open'
  | 'frozen'
  | 'settling'
  | 'settled'
  | 'voided';
export type ReceiptOutcome = 'claim_won' | 'claim_lost' | 'void';
export type ReceiptTier = 'chain_proven' | 'oracle_resolved';
export type ProofStatus = 'pending' | 'verified' | 'failed' | 'unavailable';
export type PriceProvenance = 'market' | 'modelled';
export type ReceiptCurrency = 'sol';

export interface PublicMarketTerms {
  readonly fixtureId: number;
  readonly text: string;
  readonly period: string;
  readonly trustTier: ReceiptTier;
}

export interface PublicProofNode {
  readonly hash: string;
  readonly isRightSibling: boolean;
}

export interface PublicBrowserProof {
  readonly leaf: string;
  readonly proof: readonly PublicProofNode[];
}

export interface PublicReceipt {
  marketId: string;
  groupSlug: string;
  /** Fully rendered only from a validated, compiled MarketSpec. */
  terms: PublicMarketTerms;
  status: ReceiptStatus;
  currency: ReceiptCurrency;
  priceProvenance: PriceProvenance;
  quoteProbability: number;
  quoteMultiplier: number;
  backPotLamports: string;
  doubtPotLamports: string;
  matchedAmountLamports: string;
  refundedAmountLamports: string;
  paidAmountLamports: string;
  positionCount: number;
  createdAt: string;
  outcome: ReceiptOutcome | null;
  decidingSeq: number | null;
  evidenceSeqs: number[];
  tier: ReceiptTier | null;
  settledAt: string | null;
  proofStatus: ProofStatus | null;
  explorerUrl: string | null;
  /** Browser-safe subset of the public proof record; never a transaction or wallet identifier. */
  browserProof: PublicBrowserProof | null;
}

export interface PublicGroupBoardMarket {
  marketId: string;
  groupSlug: string;
  terms: PublicMarketTerms;
  status: ReceiptStatus;
  currency: ReceiptCurrency;
  priceProvenance: PriceProvenance;
  quoteProbability: number;
  quoteMultiplier: number;
  backPotLamports: string;
  doubtPotLamports: string;
  matchedAmountLamports: string;
  refundedAmountLamports: string;
  paidAmountLamports: string;
  positionCount: number;
  createdAt: string;
  outcome: ReceiptOutcome | null;
  settledAt: string | null;
}

export interface EvidenceFact {
  fixtureId: number;
  seq: number;
  kind: string;
  confirmed: boolean;
  minute: number | null;
  goalType: string | null;
}

// ── Defensive row mapping ─────────────────────────────────────────────────

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function lamports(value: unknown): string | null {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

function sequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sequenceArray(value: unknown): number[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const sequences: number[] = [];
  for (const item of value) {
    const parsed = sequence(item);
    if (parsed === null) return null;
    sequences.push(parsed);
  }
  return sequences;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== 'string') return null;
  for (const candidate of allowed) {
    if (value === candidate) return candidate;
  }
  return null;
}

const STATUSES: readonly ReceiptStatus[] = [
  'pending_lineup',
  'open',
  'frozen',
  'settling',
  'settled',
  'voided',
];
const OUTCOMES: readonly ReceiptOutcome[] = ['claim_won', 'claim_lost', 'void'];
const TIERS: readonly ReceiptTier[] = ['chain_proven', 'oracle_resolved'];
const PROOF_STATUSES: readonly ProofStatus[] = ['pending', 'verified', 'failed', 'unavailable'];
const PROVENANCES: readonly PriceProvenance[] = ['market', 'modelled'];
const CURRENCIES: readonly ReceiptCurrency[] = ['sol'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_GROUP_SLUG = /^[A-Za-z0-9_-]{1,80}$/;
const PROOF_HASH = /^[A-Za-z0-9+/=_-]{16,256}$/;

function timestamp(value: unknown): string | null {
  const text = str(value);
  return text !== null && !Number.isNaN(Date.parse(text)) ? text : null;
}

function publicTerms(value: unknown): PublicMarketTerms | null {
  const spec = parseMarketSpec(value);
  if (!spec) return null;
  return {
    fixtureId: spec.fixtureId,
    text: describeTerms(spec),
    period: describePeriod(spec.period),
    trustTier: spec.trustTier,
  };
}

function explorerUrl(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
      ? parsed.href
      : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function browserProof(value: unknown): PublicBrowserProof | null {
  if (!isRecord(value) || typeof value.leaf !== 'string' || !PROOF_HASH.test(value.leaf)) return null;
  const rawPath = value.proof ?? value.path ?? value.siblings;
  if (!Array.isArray(rawPath)) return null;

  const proof: PublicProofNode[] = [];
  for (const node of rawPath) {
    if (!isRecord(node) || typeof node.hash !== 'string' || !PROOF_HASH.test(node.hash)) return null;
    const isRightSibling = node.isRightSibling ?? node.isRight ?? node.right;
    if (typeof isRightSibling !== 'boolean') return null;
    proof.push({ hash: node.hash, isRightSibling });
  }
  return { leaf: value.leaf, proof };
}

type PublicMarketCore = {
  marketId: string;
  groupSlug: string;
  terms: PublicMarketTerms;
  status: ReceiptStatus;
  currency: ReceiptCurrency;
  priceProvenance: PriceProvenance;
  quoteProbability: number;
  quoteMultiplier: number;
  backPotLamports: string;
  doubtPotLamports: string;
  matchedAmountLamports: string;
  refundedAmountLamports: string;
  paidAmountLamports: string;
  positionCount: number;
  createdAt: string;
  outcome: ReceiptOutcome | null;
  settledAt: string | null;
};

function publicMarketCoreFromRow(row: unknown): PublicMarketCore | null {
  if (!isRecord(row)) return null;
  const marketId = str(row.market_id);
  const groupSlug = str(row.group_slug);
  const terms = publicTerms(row.spec);
  const status = oneOf(row.status, STATUSES);
  const currency = oneOf(row.currency, CURRENCIES);
  const priceProvenance = oneOf(row.price_provenance, PROVENANCES);
  const quoteProbability = num(row.quote_probability);
  const quoteMultiplier = num(row.quote_multiplier);
  const backPotLamports = lamports(row.back_pot_lamports);
  const doubtPotLamports = lamports(row.doubt_pot_lamports);
  const matchedAmountLamports = lamports(row.matched_amount_lamports);
  const refundedAmountLamports = lamports(row.refunded_amount_lamports);
  const paidAmountLamports = lamports(row.paid_amount_lamports);
  const positionCount = count(row.position_count);
  const createdAt = timestamp(row.created_at);
  if (
    !marketId ||
    !UUID_PATTERN.test(marketId) ||
    !groupSlug ||
    !PUBLIC_GROUP_SLUG.test(groupSlug) ||
    !terms ||
    !status ||
    !currency ||
    !priceProvenance ||
    quoteProbability === null ||
    quoteProbability <= 0 ||
    quoteProbability > 1 ||
    quoteMultiplier === null ||
    quoteMultiplier <= 0 ||
    backPotLamports === null ||
    doubtPotLamports === null ||
    matchedAmountLamports === null ||
    refundedAmountLamports === null ||
    paidAmountLamports === null ||
    positionCount === null ||
    !createdAt
  ) {
    return null;
  }
  return {
    marketId,
    groupSlug,
    terms,
    status,
    currency,
    priceProvenance,
    quoteProbability,
    quoteMultiplier,
    backPotLamports,
    doubtPotLamports,
    matchedAmountLamports,
    refundedAmountLamports,
    paidAmountLamports,
    positionCount,
    createdAt,
    outcome: oneOf(row.outcome, OUTCOMES),
    settledAt: timestamp(row.settled_at),
  };
}

/** Null when the row is missing required columns — treat as not-found, never crash the page. */
export function receiptFromRow(row: unknown): PublicReceipt | null {
  if (!isRecord(row)) return null;
  const core = publicMarketCoreFromRow(row);
  const tier = oneOf(row.tier, TIERS);
  const outcome = oneOf(row.outcome, OUTCOMES);
  const settledAt = timestamp(row.settled_at);
  const decidingSeq = row.deciding_seq === null || row.deciding_seq === undefined
    ? null
    : sequence(row.deciding_seq);
  const evidenceSeqs = sequenceArray(row.evidence_seqs);
  if (
    !core ||
    evidenceSeqs === null ||
    (row.deciding_seq !== null && row.deciding_seq !== undefined && decidingSeq === null) ||
    (core.status === 'settled' && (!outcome || !tier || !settledAt)) ||
    (tier !== null && tier !== core.terms.trustTier)
  ) {
    return null;
  }
  return {
    ...core,
    outcome,
    decidingSeq,
    evidenceSeqs,
    tier,
    settledAt,
    proofStatus: oneOf(row.proof_status, PROOF_STATUSES),
    explorerUrl: explorerUrl(row.explorer_url),
    browserProof: browserProof(row.merkle_proof),
  };
}

/** Maps aggregate-only markets for the group board. No participant identity is available here. */
export function groupBoardMarketFromRow(row: unknown): PublicGroupBoardMarket | null {
  return publicMarketCoreFromRow(row);
}

/** SQL guarantees one proof-selected row per market; retained for live badge compatibility. */
export function pickBestReceiptRow(rows: readonly PublicReceipt[]): PublicReceipt | null {
  return rows[0] ?? null;
}

export function evidenceFromRow(row: unknown): EvidenceFact | null {
  if (!isRecord(row)) return null;
  const fixtureId = sequence(row.fixture_id);
  const seq = sequence(row.seq);
  const kind = str(row.kind);
  if (fixtureId === null || seq === null || !kind) return null;
  return {
    fixtureId,
    seq,
    kind,
    confirmed: row.confirmed === true,
    minute: num(row.minute),
    goalType: str(row.goal_type),
  };
}

const EVIDENCE_KIND_LABELS: Record<string, string> = {
  goal: 'Goal',
  goal_amended: 'Goal amended',
  goal_discarded: 'Goal chalked off',
  card: 'Card shown',
  var_check: 'VAR check',
  var_end: 'VAR resolved',
  phase_change: 'Phase change',
  lineup: 'Lineups in',
  possible_event: 'Match event pending',
  odds_suspension: 'Data pause',
  coverage_warning: 'Coverage warning',
  stat_update: 'Stat update',
  other: 'Match event',
};

const GOAL_TYPE_LABELS: Record<string, string> = {
  head: 'header',
  shot: 'shot',
  own_goal: 'own goal',
  penalty: 'from the spot',
};

/** Safe event copy: provider codes and player names do not become public UI text. */
export function describeEvidenceFact(fact: EvidenceFact): string {
  const event = EVIDENCE_KIND_LABELS[fact.kind] ?? 'Verified match event';
  const goalType = fact.goalType ? GOAL_TYPE_LABELS[fact.goalType] : null;
  return goalType ? `${event} (${goalType})` : event;
}
