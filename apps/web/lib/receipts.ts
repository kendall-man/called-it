/**
 * Row shapes for the public_* views (packages/db/migrations/0001_init.sql)
 * plus pure mapping helpers shared by server pages and the live trust badge.
 *
 * public_receipts selects one deterministic proof row in SQL, so every public
 * market maps to exactly one receipt row.
 */

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

export interface PublicReceipt {
  marketId: string;
  groupSlug: string;
  claimerAlias: string;
  /** Compiled MarketSpec jsonb — parse with parseMarketSpec before rendering. */
  spec: unknown;
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
  validateStatTx: string | null;
  /**
   * Not exposed by the current view; read opportunistically (select *) so an
   * additive migration lights up in-browser merkle re-verification without a
   * web deploy.
   */
  merkleProof: unknown;
}

export interface PublicGroupBoardMarket {
  marketId: string;
  groupSlug: string;
  /** Compiled MarketSpec jsonb — parse with parseMarketSpec before rendering. */
  spec: unknown;
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
  playerName: string | null;
  goalType: string | null;
}

// ── Defensive row mapping ─────────────────────────────────────────────────

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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

function numArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === 'number');
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

type PublicMarketCore = {
  marketId: string;
  groupSlug: string;
  spec: unknown;
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

function publicMarketCoreFromRow(row: Record<string, unknown>): PublicMarketCore | null {
  const marketId = str(row.market_id);
  const groupSlug = str(row.group_slug);
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
  const createdAt = str(row.created_at);
  if (
    !marketId ||
    !groupSlug ||
    !status ||
    !currency ||
    !priceProvenance ||
    quoteProbability === null ||
    quoteMultiplier === null ||
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
    spec: row.spec,
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
    settledAt: str(row.settled_at),
  };
}

/** Null when the row is missing required columns — treat as not-found, never crash the page. */
export function receiptFromRow(row: Record<string, unknown>): PublicReceipt | null {
  const core = publicMarketCoreFromRow(row);
  const claimerAlias = str(row.claimer_alias);
  if (!core || !claimerAlias) return null;
  return {
    ...core,
    claimerAlias,
    outcome: oneOf(row.outcome, OUTCOMES),
    decidingSeq: num(row.deciding_seq),
    evidenceSeqs: numArray(row.evidence_seqs),
    tier: oneOf(row.tier, TIERS),
    settledAt: str(row.settled_at),
    proofStatus: oneOf(row.proof_status, PROOF_STATUSES),
    explorerUrl: str(row.explorer_url),
    validateStatTx: str(row.validate_stat_tx),
    merkleProof: 'merkle_proof' in row ? row.merkle_proof : undefined,
  };
}

/** Maps aggregate-only markets for the group board. No participant identity is available here. */
export function groupBoardMarketFromRow(row: Record<string, unknown>): PublicGroupBoardMarket | null {
  return publicMarketCoreFromRow(row);
}

/** SQL guarantees one proof-selected row per market; retained for live badge compatibility. */
export function pickBestReceiptRow(rows: readonly PublicReceipt[]): PublicReceipt | null {
  return rows[0] ?? null;
}

export function evidenceFromRow(row: Record<string, unknown>): EvidenceFact | null {
  const fixtureId = num(row.fixture_id);
  const seq = num(row.seq);
  const kind = str(row.kind);
  if (fixtureId === null || seq === null || !kind) return null;
  return {
    fixtureId,
    seq,
    kind,
    confirmed: row.confirmed === true,
    minute: num(row.minute),
    playerName: str(row.player_name),
    goalType: str(row.goal_type),
  };
}
