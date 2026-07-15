/**
 * Read-only queries against the public_* views. Anything unexpected from the
 * network degrades to a typed result — receipt pages must never white-screen
 * because the scoreboard hiccuped.
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
  type PublicEscrowReceipt,
} from './escrow-receipts';

export type QueryResult<T> = { ok: true; data: T } | { ok: false };

type EscrowOverlayResult<T> =
  | { readonly kind: 'available'; readonly data: T }
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
  const [legacy, escrowResult] = await Promise.all([
    client.from(RECEIPTS_VIEW).select(PUBLIC_RECEIPT_SELECT).eq('market_id', marketId).limit(2),
    fetchEscrowForMarket(client, marketId),
  ]);
  const { data, error } = legacy;
  const receipts = mapRows(data, receiptFromRow);
  if (error || receipts === null || receipts.length > 1) return { ok: false };
  const receipt = receipts[0] ?? null;
  if (escrowResult.kind === 'unavailable') return { ok: true, data: receipt };
  if (escrowResult.kind === 'invalid') return { ok: false };
  if (receipt === null && escrowResult.data !== null) return { ok: false };
  return {
    ok: true,
    data: receipt === null || escrowResult.data === null
      ? receipt
      : { ...receipt, escrow: escrowResult.data },
  };
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
 * The group's receipts index — every call this group has put on the record,
 * newest first. The views expose no groups row directly, so a slug with zero
 * receipts is either unknown or web-disabled: null → 404 territory.
 */
export async function fetchGroupReceipts(
  client: SupabaseClient,
  slug: string,
): Promise<QueryResult<PublicReceipt[] | null>> {
  const [legacy, escrowResult] = await Promise.all([
    client
      .from(RECEIPTS_VIEW)
      .select(PUBLIC_RECEIPT_SELECT)
      .eq('group_slug', slug)
      .order('created_at', { ascending: false })
      .limit(GROUP_RECEIPTS_FETCH_LIMIT),
    fetchEscrowForGroup(client, slug),
  ]);
  const { data, error } = legacy;
  const mapped = mapRows(data, receiptFromRow);
  const deduped = mapped === null ? null : dedupeMarketRows(mapped);
  if (error || deduped === null) return { ok: false };
  if (escrowResult.kind === 'unavailable') {
    const receipts = deduped.slice(0, GROUP_RECEIPTS_SHOWN);
    return { ok: true, data: receipts.length === 0 ? null : receipts };
  }
  if (escrowResult.kind === 'invalid') return { ok: false };
  if (escrowResult.data.some((escrow) => !deduped.some((row) => row.marketId === escrow.marketId))) {
    return { ok: false };
  }

  const receipts = mergeEscrowOverlays(deduped, escrowResult.data).slice(0, GROUP_RECEIPTS_SHOWN);
  if (receipts.length === 0) return { ok: true, data: null };
  return { ok: true, data: receipts };
}

/** Aggregate-only board rows. Receipt identity is deliberately unavailable on this surface. */
export async function fetchGroupBoard(
  client: SupabaseClient,
  slug: string,
): Promise<QueryResult<PublicGroupBoardMarket[] | null>> {
  const [legacy, escrowResult] = await Promise.all([
    client
      .from(GROUP_BOARD_VIEW)
      .select(PUBLIC_GROUP_BOARD_SELECT)
      .eq('group_slug', slug)
      .order('created_at', { ascending: false })
      .limit(GROUP_RECEIPTS_FETCH_LIMIT),
    fetchEscrowForGroup(client, slug),
  ]);
  const { data, error } = legacy;
  const mapped = mapRows(data, groupBoardMarketFromRow);
  const deduped = mapped === null ? null : dedupeMarketRows(mapped);
  if (error || deduped === null) return { ok: false };
  if (escrowResult.kind === 'unavailable') {
    const markets = deduped.slice(0, GROUP_RECEIPTS_SHOWN);
    return { ok: true, data: markets.length === 0 ? null : markets };
  }
  if (escrowResult.kind === 'invalid') return { ok: false };
  if (escrowResult.data.some((escrow) => !deduped.some((row) => row.marketId === escrow.marketId))) {
    return { ok: false };
  }

  const markets = mergeEscrowOverlays(deduped, escrowResult.data).slice(0, GROUP_RECEIPTS_SHOWN);
  return { ok: true, data: markets.length === 0 ? null : markets };
}

export function mergeEscrowOverlays<T extends { readonly marketId: string }>(
  legacyRows: readonly T[],
  escrowRows: readonly PublicEscrowReceipt[],
): Array<T & { readonly escrow?: PublicEscrowReceipt }> {
  const escrowByMarket = new Map(escrowRows.map((row) => [row.marketId, row]));
  const uniqueLegacyRows = new Map<string, T>();
  for (const row of legacyRows) {
    if (!uniqueLegacyRows.has(row.marketId)) uniqueLegacyRows.set(row.marketId, row);
  }
  return [...uniqueLegacyRows.values()].map((row) => {
    const escrow = escrowByMarket.get(row.marketId);
    return escrow === undefined ? row : { ...row, escrow };
  });
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

async function fetchEscrowForMarket(
  client: SupabaseClient,
  marketId: string,
): Promise<EscrowOverlayResult<PublicEscrowReceipt | null>> {
  const receiptResult = await client
    .from(ESCROW_RECEIPTS_VIEW)
    .select(PUBLIC_ESCROW_RECEIPT_SELECT)
    .eq('market_id', marketId)
    .limit(2);
  if (receiptResult.error) return { kind: 'unavailable' };
  const receiptRows = Array.isArray(receiptResult.data) ? receiptResult.data : null;
  if (receiptRows === null) return { kind: 'invalid' };
  if (receiptRows.length === 0) return { kind: 'available', data: null };
  const [aggregateResult, claimResult] = await Promise.all([
    client.from(ESCROW_AGGREGATES_VIEW).select(PUBLIC_ESCROW_AGGREGATE_SELECT).eq('market_id', marketId),
    client.from(ESCROW_CLAIMS_VIEW).select(PUBLIC_ESCROW_CLAIM_SELECT).eq('market_id', marketId),
  ]);
  if (aggregateResult.error || claimResult.error) return { kind: 'unavailable' };
  const assembled = assembleEscrowReceipts(receiptRows, aggregateResult.data, claimResult.data);
  if (assembled === null || assembled.length !== 1) return { kind: 'invalid' };
  return { kind: 'available', data: assembled[0] ?? null };
}

async function fetchEscrowForGroup(
  client: SupabaseClient,
  slug: string,
): Promise<EscrowOverlayResult<readonly PublicEscrowReceipt[]>> {
  const receiptResult = await client
    .from(ESCROW_RECEIPTS_VIEW)
    .select(PUBLIC_ESCROW_RECEIPT_SELECT)
    .eq('group_slug', slug)
    .limit(GROUP_RECEIPTS_FETCH_LIMIT);
  if (receiptResult.error) return { kind: 'unavailable' };
  if (!Array.isArray(receiptResult.data)) return { kind: 'invalid' };
  const rows = receiptResult.data;
  if (rows.length === 0) return { kind: 'available', data: [] };
  const parsed = mapRows(rows, escrowReceiptFromRow);
  if (parsed === null) return { kind: 'invalid' };
  const marketIds = [...new Set(parsed.map((row) => row.marketId))];
  const [aggregateResult, claimResult] = await Promise.all([
    client.from(ESCROW_AGGREGATES_VIEW).select(PUBLIC_ESCROW_AGGREGATE_SELECT).in('market_id', marketIds),
    client.from(ESCROW_CLAIMS_VIEW).select(PUBLIC_ESCROW_CLAIM_SELECT).in('market_id', marketIds),
  ]);
  if (aggregateResult.error || claimResult.error) return { kind: 'unavailable' };
  const assembled = assembleEscrowReceipts(rows, aggregateResult.data, claimResult.data);
  return assembled === null
    ? { kind: 'invalid' }
    : { kind: 'available', data: assembled };
}
