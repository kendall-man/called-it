/**
 * Row shapes for the public_* views (packages/db/migrations/0001_init.sql)
 * plus pure mapping helpers shared by server pages and the live trust badge.
 *
 * public_receipts left-joins proofs, so one market can come back as several
 * rows (one per proof row); `pickBestReceiptRow` collapses them.
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

export interface PublicReceipt {
  marketId: string;
  groupSlug: string;
  quotedText: string;
  claimerName: string;
  /** Compiled MarketSpec jsonb — parse with parseMarketSpec before rendering. */
  spec: unknown;
  status: ReceiptStatus;
  isReplay: boolean;
  priceProvenance: PriceProvenance;
  quoteProbability: number;
  quoteMultiplier: number;
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

export interface LeaderboardEntry {
  displayName: string;
  points: number;
  streak: number;
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

function numArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === 'number');
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
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

/** Null when the row is missing required columns — treat as not-found, never crash the page. */
export function receiptFromRow(row: Record<string, unknown>): PublicReceipt | null {
  const marketId = str(row.market_id);
  const groupSlug = str(row.group_slug);
  const status = oneOf(row.status, STATUSES);
  const priceProvenance = oneOf(row.price_provenance, PROVENANCES);
  const quoteProbability = num(row.quote_probability);
  const quoteMultiplier = num(row.quote_multiplier);
  const createdAt = str(row.created_at);
  if (
    !marketId ||
    !groupSlug ||
    !status ||
    !priceProvenance ||
    quoteProbability === null ||
    quoteMultiplier === null ||
    !createdAt
  ) {
    return null;
  }
  return {
    marketId,
    groupSlug,
    quotedText: str(row.quoted_text) ?? '',
    claimerName: str(row.claimer_name) ?? 'Someone',
    spec: row.spec,
    status,
    isReplay: row.is_replay === true,
    priceProvenance,
    quoteProbability,
    quoteMultiplier,
    createdAt,
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

/** Higher wins when collapsing the proofs left-join fan-out. */
const PROOF_RANK: Record<ProofStatus, number> = {
  verified: 4,
  pending: 3,
  failed: 2,
  unavailable: 1,
};

function proofRank(receipt: PublicReceipt): number {
  return receipt.proofStatus ? PROOF_RANK[receipt.proofStatus] : 0;
}

export function pickBestReceiptRow(rows: PublicReceipt[]): PublicReceipt | null {
  let best: PublicReceipt | null = null;
  for (const row of rows) {
    if (!best || proofRank(row) > proofRank(best)) best = row;
  }
  return best;
}

/** Collapse a multi-market result set to one (best-proof) row per market, input order preserved. */
export function dedupeReceipts(rows: PublicReceipt[]): PublicReceipt[] {
  const byMarket = new Map<string, PublicReceipt>();
  for (const row of rows) {
    const current = byMarket.get(row.marketId);
    if (!current || proofRank(row) > proofRank(current)) byMarket.set(row.marketId, row);
  }
  return [...byMarket.values()];
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

export function leaderboardEntryFromRow(row: Record<string, unknown>): LeaderboardEntry | null {
  const displayName = str(row.display_name);
  const points = num(row.points_cached);
  if (!displayName || points === null) return null;
  return { displayName, points, streak: num(row.streak) ?? 0 };
}
