/**
 * Read-only queries against the public_* views. Anything unexpected from the
 * network degrades to a typed result — receipt pages must never white-screen
 * because the scoreboard hiccuped.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dedupeReceipts,
  evidenceFromRow,
  pickBestReceiptRow,
  receiptFromRow,
  type EvidenceFact,
  type PublicReceipt,
} from './receipts';

export type QueryResult<T> = { ok: true; data: T } | { ok: false; message: string };

const RECEIPTS_VIEW = 'public_receipts';
const EVIDENCE_VIEW = 'public_evidence';

const GROUP_RECEIPTS_FETCH_LIMIT = 60;
const GROUP_RECEIPTS_SHOWN = 12;

function mapRows<T>(rows: unknown, mapRow: (row: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(rows)) return [];
  const mapped: T[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const value = mapRow(row as Record<string, unknown>);
    if (value !== null) mapped.push(value);
  }
  return mapped;
}

export async function fetchReceipt(
  client: SupabaseClient,
  marketId: string,
): Promise<QueryResult<PublicReceipt | null>> {
  const { data, error } = await client
    .from(RECEIPTS_VIEW)
    .select('*')
    .eq('market_id', marketId);
  if (error) return { ok: false, message: error.message };
  return { ok: true, data: pickBestReceiptRow(mapRows(data, receiptFromRow)) };
}

export async function fetchEvidence(
  client: SupabaseClient,
  fixtureId: number,
  seqs: number[],
): Promise<QueryResult<EvidenceFact[]>> {
  if (seqs.length === 0) return { ok: true, data: [] };
  const { data, error } = await client
    .from(EVIDENCE_VIEW)
    .select('*')
    .eq('fixture_id', fixtureId)
    .in('seq', seqs)
    .order('seq', { ascending: true });
  if (error) return { ok: false, message: error.message };
  return { ok: true, data: mapRows(data, evidenceFromRow) };
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
    .select('*')
    .eq('group_slug', slug)
    .order('created_at', { ascending: false })
    .limit(GROUP_RECEIPTS_FETCH_LIMIT);
  if (error) return { ok: false, message: error.message };

  const receipts = dedupeReceipts(mapRows(data, receiptFromRow)).slice(0, GROUP_RECEIPTS_SHOWN);
  if (receipts.length === 0) return { ok: true, data: null };
  return { ok: true, data: receipts };
}
