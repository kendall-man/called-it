/**
 * Read-only queries against the public_* views. Anything unexpected from the
 * network degrades to a typed result so receipt pages render an explicit state
 * instead of throwing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  evidenceFromRow,
  groupBoardMarketFromRow,
  receiptFromRow,
  type EvidenceFact,
  type PublicGroupBoardMarket,
  type PublicReceipt,
} from './receipts';
import {
  assembleEscrowReceipts,
  escrowReceiptFromRow,
  getPublicEscrowIdentityConfig,
  publicGroupBoardMarketFromEscrow,
  publicReceiptFromEscrow,
  type PublicEscrowReceipt,
} from './escrow-receipts';

export type QueryResult<T> = { ok: true; data: T } | { ok: false };

type SourceResult<T> =
  | { readonly kind: 'available'; readonly data: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'invalid' };

const RECEIPTS_VIEW = 'public_receipts';
const GROUP_BOARD_VIEW = 'public_group_board';
const EVIDENCE_VIEW = 'public_evidence';
const ESCROW_RECEIPTS_VIEW = 'public_escrow_receipts';
const ESCROW_AGGREGATES_VIEW = 'public_escrow_position_aggregates';
const ESCROW_CLAIMS_VIEW = 'public_escrow_claim_transactions';

const GROUP_RECEIPTS_FETCH_LIMIT = 60;
const GROUP_RECEIPTS_SHOWN = 12;

export const PUBLIC_RECEIPT_SELECT = [
  'market_id',
  'group_slug',
  'spec',
  'status',
  'currency',
  'price_provenance',
  'quote_probability',
  'quote_multiplier',
  'back_pot_lamports',
  'doubt_pot_lamports',
  'matched_amount_lamports',
  'refunded_amount_lamports',
  'paid_amount_lamports',
  'position_count',
  'created_at',
  'outcome',
  'deciding_seq',
  'evidence_seqs',
  'tier',
  'settled_at',
  'proof_status',
  'explorer_url',
  'merkle_proof',
].join(',');

export const PUBLIC_GROUP_BOARD_SELECT = [
  'market_id',
  'group_slug',
  'spec',
  'status',
  'currency',
  'price_provenance',
  'quote_probability',
  'quote_multiplier',
  'back_pot_lamports',
  'doubt_pot_lamports',
  'matched_amount_lamports',
  'refunded_amount_lamports',
  'paid_amount_lamports',
  'position_count',
  'created_at',
  'outcome',
  'settled_at',
].join(',');

const PUBLIC_EVIDENCE_SELECT = ['fixture_id', 'seq', 'kind', 'confirmed', 'minute', 'goal_type'].join(',');

export const PUBLIC_ESCROW_RECEIPT_SELECT = [
  'market_id',
  'group_slug',
  'web_enabled',
  'cluster',
  'program_id',
  'market_pda',
  'vault_pda',
  'asset',
  'document_hash_hex',
  'initialize_signature',
  'initialize_slot',
  'outcome',
  'settlement_signature',
  'settlement_slot',
  'evidence_hash_hex',
  'settled_at',
  'fixture_id',
  'fixture_p1_name',
  'fixture_p2_name',
  'spec',
  'is_replay',
  'kickoff_at',
  'created_at',
  'price_provenance',
  'quote_probability',
  'quote_multiplier',
  'probability_ppm',
  'ratio_milli',
  'currency',
  'genesis_hash',
  'mint_pubkey',
  'custody_version',
  'chain_state',
  'initialize_instruction_index',
  'initialize_block_time',
  'settlement_instruction_index',
  'status',
].join(',');

export const PUBLIC_ESCROW_AGGREGATE_SELECT = [
  'market_id',
  'cluster',
  'asset',
  'side',
  'state',
  'lot_count',
  'amount_atomic',
].join(',');

export const PUBLIC_ESCROW_CLAIM_SELECT = [
  'market_id',
  'cluster',
  'claim_signature',
  'claim_slot',
  'claimed_at',
  'asset',
  'claim_kind',
  'recipient_count',
  'amount_atomic',
].join(',');

function mapRows<T>(rows: unknown, mapRow: (row: unknown) => T | null): T[] | null {
  if (!Array.isArray(rows)) return null;
  const mapped: T[] = [];
  for (const row of rows) {
    const value = mapRow(row);
    if (value === null) return null;
    mapped.push(value);
  }
  return mapped;
}

export async function fetchReceipt(
  client: SupabaseClient,
  marketId: string,
): Promise<QueryResult<PublicReceipt | null>> {
  const [legacyResult, escrowResult] = await Promise.all([
    fetchLegacyReceipt(client, marketId),
    fetchEscrowForMarket(client, marketId),
  ]);
  if (legacyResult.kind === 'invalid' || legacyResult.kind === 'unavailable' ||
      escrowResult.kind === 'invalid' || escrowResult.kind === 'unavailable') return { ok: false };
  if (escrowResult.kind === 'missing') {
    return legacyResult.kind === 'available'
      ? { ok: true, data: legacyResult.data }
      : { ok: false };
  }
  const escrowReceipt = escrowResult.data === null
    ? null
    : publicReceiptFromEscrow(escrowResult.data);
  if (escrowResult.data !== null && escrowReceipt === null) return { ok: false };
  if (legacyResult.kind === 'missing') return { ok: true, data: escrowReceipt };
  const merged = mergeReceiptSources(
    legacyResult.data === null ? [] : [legacyResult.data],
    escrowReceipt === null ? [] : [escrowReceipt],
  );
  if (merged === null || merged.length > 1) return { ok: false };
  return { ok: true, data: merged[0] ?? null };
}

export async function fetchEvidence(
  client: SupabaseClient,
  fixtureId: number,
  seqs: readonly number[],
): Promise<QueryResult<EvidenceFact[]>> {
  if (seqs.length === 0) return { ok: true, data: [] };
  const { data, error } = await client
    .from(EVIDENCE_VIEW)
    .select(PUBLIC_EVIDENCE_SELECT)
    .eq('fixture_id', fixtureId)
    .in('seq', seqs)
    .order('seq', { ascending: true });
  const facts = mapRows(data, evidenceFromRow);
  if (error || facts === null) return { ok: false };
  return { ok: true, data: facts };
}

/**
 * The group's receipts index, newest first. A slug with zero rows across the
 * available public sources is unknown or web-disabled and maps to null.
 */
export async function fetchGroupReceipts(
  client: SupabaseClient,
  slug: string,
): Promise<QueryResult<PublicReceipt[] | null>> {
  const [legacyResult, escrowResult] = await Promise.all([
    fetchLegacyGroupReceipts(client, slug),
    fetchEscrowForGroup(client, slug),
  ]);
  if (escrowResult.kind === 'missing') {
    if (legacyResult.kind !== 'available') return { ok: false };
    const receipts = legacyResult.data.slice(0, GROUP_RECEIPTS_SHOWN);
    return { ok: true, data: receipts.length === 0 ? null : receipts };
  }
  if (escrowResult.kind !== 'available') return { ok: false };
  const escrowReceipts = escrowResult.data.map(publicReceiptFromEscrow);
  const validEscrowReceipts = nonNull(escrowReceipts);
  if (legacyResult.kind === 'missing') {
    const receipts = newestFirst(validEscrowReceipts).slice(0, GROUP_RECEIPTS_SHOWN);
    return { ok: true, data: receipts.length === 0 ? null : receipts };
  }
  if (legacyResult.kind !== 'available') return { ok: false };
  const merged = mergeGroupReceiptSources(legacyResult.data, validEscrowReceipts);
  const receipts = merged.slice(0, GROUP_RECEIPTS_SHOWN);
  return { ok: true, data: receipts.length === 0 ? null : receipts };
}

/** Aggregate-only board rows. Receipt identity is deliberately unavailable on this surface. */
export async function fetchGroupBoard(
  client: SupabaseClient,
  slug: string,
): Promise<QueryResult<PublicGroupBoardMarket[] | null>> {
  const [legacyResult, escrowResult] = await Promise.all([
    fetchLegacyGroupBoard(client, slug),
    fetchEscrowForGroup(client, slug),
  ]);
  if (escrowResult.kind === 'missing') {
    if (legacyResult.kind !== 'available') return { ok: false };
    const markets = legacyResult.data.slice(0, GROUP_RECEIPTS_SHOWN);
    return { ok: true, data: markets.length === 0 ? null : markets };
  }
  if (escrowResult.kind !== 'available') return { ok: false };
  const escrowMarkets = escrowResult.data.map(publicGroupBoardMarketFromEscrow);
  const validEscrowMarkets = nonNull(escrowMarkets);
  if (legacyResult.kind === 'missing') {
    const markets = newestFirst(validEscrowMarkets).slice(0, GROUP_RECEIPTS_SHOWN);
    return { ok: true, data: markets.length === 0 ? null : markets };
  }
  if (legacyResult.kind !== 'available') return { ok: false };
  const merged = mergeGroupBoardSources(legacyResult.data, validEscrowMarkets);
  const markets = merged.slice(0, GROUP_RECEIPTS_SHOWN);
  return { ok: true, data: markets.length === 0 ? null : markets };
}

/**
 * Group indexes can outlive old escrow schema versions. Preserve a valid
 * legacy projection when the escrow copy of one market is contradictory;
 * direct receipt lookups continue to use the strict merger above.
 */
function mergeGroupReceiptSources(
  legacyRows: readonly PublicReceipt[],
  escrowRows: readonly PublicReceipt[],
): PublicReceipt[] {
  const values = new Map(legacyRows.map((row) => [row.marketId, row]));
  for (const escrowRow of escrowRows) {
    const legacyRow = values.get(escrowRow.marketId);
    if (legacyRow === undefined) {
      values.set(escrowRow.marketId, escrowRow);
      continue;
    }
    if (!sameMarketIdentity(legacyRow, escrowRow)) continue;
    values.set(escrowRow.marketId, {
      ...escrowRow,
      decidingSeq: legacyRow.decidingSeq,
      evidenceSeqs: legacyRow.evidenceSeqs,
      tier: legacyRow.tier ?? escrowRow.tier,
      proofStatus: legacyRow.proofStatus,
      explorerUrl: legacyRow.explorerUrl,
      browserProof: legacyRow.browserProof,
    });
  }
  return newestFirst([...values.values()]);
}

function mergeGroupBoardSources(
  legacyRows: readonly PublicGroupBoardMarket[],
  escrowRows: readonly PublicGroupBoardMarket[],
): PublicGroupBoardMarket[] {
  const values = new Map(legacyRows.map((row) => [row.marketId, row]));
  for (const escrowRow of escrowRows) {
    const legacyRow = values.get(escrowRow.marketId);
    if (legacyRow !== undefined && !sameMarketIdentity(legacyRow, escrowRow)) continue;
    values.set(escrowRow.marketId, escrowRow);
  }
  return newestFirst([...values.values()]);
}

export function mergeReceiptSources(
  legacyRows: readonly PublicReceipt[],
  escrowRows: readonly PublicReceipt[],
): PublicReceipt[] | null {
  const legacy = dedupeMarketRows(legacyRows);
  const escrow = dedupeMarketRows(escrowRows);
  if (legacy === null || escrow === null) return null;
  const values = new Map(legacy.map((row) => [row.marketId, row]));
  for (const escrowRow of escrow) {
    const legacyRow = values.get(escrowRow.marketId);
    if (legacyRow === undefined) {
      values.set(escrowRow.marketId, escrowRow);
      continue;
    }
    if (!sameMarketIdentity(legacyRow, escrowRow)) return null;
    values.set(escrowRow.marketId, {
      ...escrowRow,
      decidingSeq: legacyRow.decidingSeq,
      evidenceSeqs: legacyRow.evidenceSeqs,
      tier: legacyRow.tier ?? escrowRow.tier,
      proofStatus: legacyRow.proofStatus,
      explorerUrl: legacyRow.explorerUrl,
      browserProof: legacyRow.browserProof,
    });
  }
  return newestFirst([...values.values()]);
}

export function mergeBoardSources(
  legacyRows: readonly PublicGroupBoardMarket[],
  escrowRows: readonly PublicGroupBoardMarket[],
): PublicGroupBoardMarket[] | null {
  const legacy = dedupeMarketRows(legacyRows);
  const escrow = dedupeMarketRows(escrowRows);
  if (legacy === null || escrow === null) return null;
  const values = new Map(legacy.map((row) => [row.marketId, row]));
  for (const escrowRow of escrow) {
    const legacyRow = values.get(escrowRow.marketId);
    if (legacyRow !== undefined && !sameMarketIdentity(legacyRow, escrowRow)) return null;
    values.set(escrowRow.marketId, escrowRow);
  }
  return newestFirst([...values.values()]);
}

function sameMarketIdentity(
  legacy: PublicReceipt | PublicGroupBoardMarket,
  escrow: PublicReceipt | PublicGroupBoardMarket,
): boolean {
  return (
    legacy.marketId === escrow.marketId &&
    legacy.groupSlug === escrow.groupSlug &&
    JSON.stringify(legacy.terms) === JSON.stringify(escrow.terms) &&
    legacy.status === escrow.status &&
    legacy.currency === escrow.currency &&
    legacy.priceProvenance === escrow.priceProvenance &&
    legacy.quoteProbability === escrow.quoteProbability &&
    legacy.quoteMultiplier === escrow.quoteMultiplier &&
    legacy.createdAt === escrow.createdAt &&
    legacy.outcome === escrow.outcome &&
    Boolean(legacy.isReplay) === Boolean(escrow.isReplay)
  );
}

function dedupeMarketRows<T extends { readonly marketId: string }>(rows: readonly T[]): T[] | null {
  const values = new Map<string, T>();
  for (const row of rows) {
    const current = values.get(row.marketId);
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(row)) return null;
    values.set(row.marketId, row);
  }
  return [...values.values()];
}

function newestFirst<T extends { readonly marketId: string; readonly createdAt: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => {
    const byTime = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return byTime === 0 ? left.marketId.localeCompare(right.marketId) : byTime;
  });
}

function nonNull<T>(rows: readonly (T | null)[]): T[] {
  return rows.filter((row): row is T => row !== null);
}

async function fetchLegacyReceipt(
  client: SupabaseClient,
  marketId: string,
): Promise<SourceResult<PublicReceipt | null>> {
  const result = await client
    .from(RECEIPTS_VIEW)
    .select(PUBLIC_RECEIPT_SELECT)
    .eq('market_id', marketId)
    .limit(2);
  if (result.error) return sourceFailure(result.error);
  const mapped = mapRows(result.data, receiptFromRow);
  const deduped = mapped === null ? null : dedupeMarketRows(mapped);
  if (deduped === null || deduped.length > 1) return { kind: 'invalid' };
  return { kind: 'available', data: deduped[0] ?? null };
}

async function fetchLegacyGroupReceipts(
  client: SupabaseClient,
  slug: string,
): Promise<SourceResult<readonly PublicReceipt[]>> {
  const result = await client
    .from(RECEIPTS_VIEW)
    .select(PUBLIC_RECEIPT_SELECT)
    .eq('group_slug', slug)
    .order('created_at', { ascending: false })
    .limit(GROUP_RECEIPTS_FETCH_LIMIT);
  if (result.error) return sourceFailure(result.error);
  const mapped = mapRows(result.data, receiptFromRow);
  const deduped = mapped === null ? null : dedupeMarketRows(mapped);
  return deduped === null
    ? { kind: 'invalid' }
    : { kind: 'available', data: newestFirst(deduped) };
}

async function fetchLegacyGroupBoard(
  client: SupabaseClient,
  slug: string,
): Promise<SourceResult<readonly PublicGroupBoardMarket[]>> {
  const result = await client
    .from(GROUP_BOARD_VIEW)
    .select(PUBLIC_GROUP_BOARD_SELECT)
    .eq('group_slug', slug)
    .order('created_at', { ascending: false })
    .limit(GROUP_RECEIPTS_FETCH_LIMIT);
  if (result.error) return sourceFailure(result.error);
  const mapped = mapRows(result.data, groupBoardMarketFromRow);
  const deduped = mapped === null ? null : dedupeMarketRows(mapped);
  return deduped === null
    ? { kind: 'invalid' }
    : { kind: 'available', data: newestFirst(deduped) };
}

async function fetchEscrowForMarket(
  client: SupabaseClient,
  marketId: string,
): Promise<SourceResult<PublicEscrowReceipt | null>> {
  const receiptResult = await client
    .from(ESCROW_RECEIPTS_VIEW)
    .select(PUBLIC_ESCROW_RECEIPT_SELECT)
    .eq('market_id', marketId)
    .limit(2);
  if (receiptResult.error) return sourceFailure(receiptResult.error);
  const receiptRows = Array.isArray(receiptResult.data) ? receiptResult.data : null;
  if (receiptRows === null) return { kind: 'invalid' };
  if (receiptRows.length === 0) return { kind: 'available', data: null };
  const identity = getPublicEscrowIdentityConfig();
  if (identity === null) return { kind: 'invalid' };
  const [aggregateResult, claimResult] = await Promise.all([
    client.from(ESCROW_AGGREGATES_VIEW).select(PUBLIC_ESCROW_AGGREGATE_SELECT).eq('market_id', marketId),
    client.from(ESCROW_CLAIMS_VIEW).select(PUBLIC_ESCROW_CLAIM_SELECT).eq('market_id', marketId),
  ]);
  if (aggregateResult.error || claimResult.error) {
    return combinedSourceFailure(aggregateResult.error, claimResult.error);
  }
  const assembled = assembleEscrowReceipts(
    receiptRows,
    aggregateResult.data,
    claimResult.data,
    identity,
  );
  if (assembled === null || assembled.length !== 1) return { kind: 'invalid' };
  return { kind: 'available', data: assembled[0] ?? null };
}

async function fetchEscrowForGroup(
  client: SupabaseClient,
  slug: string,
): Promise<SourceResult<readonly PublicEscrowReceipt[]>> {
  const receiptResult = await client
    .from(ESCROW_RECEIPTS_VIEW)
    .select(PUBLIC_ESCROW_RECEIPT_SELECT)
    .eq('group_slug', slug)
    .order('created_at', { ascending: false })
    .limit(GROUP_RECEIPTS_FETCH_LIMIT);
  if (receiptResult.error) return sourceFailure(receiptResult.error);
  if (!Array.isArray(receiptResult.data)) return { kind: 'invalid' };
  const rows = receiptResult.data;
  if (rows.length === 0) return { kind: 'available', data: [] };
  const identity = getPublicEscrowIdentityConfig();
  if (identity === null) return { kind: 'invalid' };
  const candidates = rows.flatMap((row) => {
    const parsed = escrowReceiptFromRow(row, identity);
    return parsed === null ? [] : [{ raw: row, parsed }];
  });
  const marketIds = [...new Set(candidates.map(({ parsed }) => parsed.marketId))];
  if (marketIds.length === 0) return { kind: 'available', data: [] };
  const [aggregateResult, claimResult] = await Promise.all([
    client.from(ESCROW_AGGREGATES_VIEW).select(PUBLIC_ESCROW_AGGREGATE_SELECT).in('market_id', marketIds),
    client.from(ESCROW_CLAIMS_VIEW).select(PUBLIC_ESCROW_CLAIM_SELECT).in('market_id', marketIds),
  ]);
  if (aggregateResult.error || claimResult.error) {
    return combinedSourceFailure(aggregateResult.error, claimResult.error);
  }
  if (!Array.isArray(aggregateResult.data) || !Array.isArray(claimResult.data)) {
    return { kind: 'invalid' };
  }
  const assembled: PublicEscrowReceipt[] = [];
  for (const marketId of marketIds) {
    const market = assembleEscrowReceipts(
      candidates.filter(({ parsed }) => parsed.marketId === marketId).map(({ raw }) => raw),
      aggregateResult.data.filter((row) => rowMarketId(row) === marketId),
      claimResult.data.filter((row) => rowMarketId(row) === marketId),
      identity,
    );
    if (market?.length === 1 && market[0] !== undefined) assembled.push(market[0]);
  }
  return { kind: 'available', data: assembled };
}

function rowMarketId(row: unknown): string | null {
  if (typeof row !== 'object' || row === null || !('market_id' in row)) return null;
  return typeof row.market_id === 'string' ? row.market_id : null;
}

function sourceFailure(error: unknown): SourceResult<never> {
  return isMissingViewError(error) ? { kind: 'missing' } : { kind: 'unavailable' };
}

function combinedSourceFailure(...errors: readonly unknown[]): SourceResult<never> {
  const failures = errors.filter((error) => error !== null && error !== undefined);
  return failures.length > 0 && failures.every(isMissingViewError)
    ? { kind: 'missing' }
    : { kind: 'unavailable' };
}

function isMissingViewError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === '42P01' || error.code === 'PGRST205';
}
