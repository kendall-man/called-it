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

export type QueryResult<T> = { ok: true; data: T } | { ok: false };

const RECEIPTS_VIEW = 'public_receipts';
const GROUP_BOARD_VIEW = 'public_group_board';
const EVIDENCE_VIEW = 'public_evidence';

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
  const { data, error } = await client
    .from(RECEIPTS_VIEW)
    .select(PUBLIC_RECEIPT_SELECT)
    .eq('market_id', marketId)
    .limit(2);
  const receipts = mapRows(data, receiptFromRow);
  if (error || receipts === null || receipts.length > 1) return { ok: false };
  return { ok: true, data: receipts[0] ?? null };
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
  const { data, error } = await client
    .from(RECEIPTS_VIEW)
    .select(PUBLIC_RECEIPT_SELECT)
    .eq('group_slug', slug)
    .order('created_at', { ascending: false })
    .limit(GROUP_RECEIPTS_FETCH_LIMIT);
  const mapped = mapRows(data, receiptFromRow);
  if (error || mapped === null) return { ok: false };

  const receipts = mapped.slice(0, GROUP_RECEIPTS_SHOWN);
  if (receipts.length === 0) return { ok: true, data: null };
  return { ok: true, data: receipts };
}

/** Aggregate-only board rows. Receipt identity is deliberately unavailable on this surface. */
export async function fetchGroupBoard(
  client: SupabaseClient,
  slug: string,
): Promise<QueryResult<PublicGroupBoardMarket[] | null>> {
  const { data, error } = await client
    .from(GROUP_BOARD_VIEW)
    .select(PUBLIC_GROUP_BOARD_SELECT)
    .eq('group_slug', slug)
    .order('created_at', { ascending: false })
    .limit(GROUP_RECEIPTS_FETCH_LIMIT);
  const mapped = mapRows(data, groupBoardMarketFromRow);
  if (error || mapped === null) return { ok: false };

  const markets = mapped.slice(0, GROUP_RECEIPTS_SHOWN);
  return { ok: true, data: markets.length === 0 ? null : markets };
}
