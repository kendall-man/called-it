/**
 * Read-only queries against the public_* views. Anything unexpected from the
 * network degrades to a typed result — receipt pages must never white-screen
 * because the scoreboard hiccuped.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dedupeReceipts,
  evidenceFromRow,
  leaderboardEntryFromRow,
  pickBestReceiptRow,
  receiptFromRow,
  type EvidenceFact,
  type LeaderboardEntry,
  type PublicReceipt,
} from './receipts';

export type QueryResult<T> = { ok: true; data: T } | { ok: false; message: string };

const RECEIPTS_VIEW = 'public_receipts';
const LEADERBOARD_VIEW = 'public_leaderboard';
const EVIDENCE_VIEW = 'public_evidence';

const LEADERBOARD_LIMIT = 50;
const RECENT_RECEIPTS_FETCH_LIMIT = 60;
const RECENT_RECEIPTS_SHOWN = 12;
const HALL_OF_CALLS_FETCH_LIMIT = 25;
const HALL_OF_CALLS_SIZE = 5;

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

export interface GroupBoard {
  leaderboard: LeaderboardEntry[];
  hallOfCalls: PublicReceipt[];
  recentReceipts: PublicReceipt[];
}

export async function fetchGroupBoard(
  client: SupabaseClient,
  slug: string,
): Promise<QueryResult<GroupBoard | null>> {
  const [leadersRes, recentRes, hallRes] = await Promise.all([
    client
      .from(LEADERBOARD_VIEW)
      .select('*')
      .eq('group_slug', slug)
      .order('points_cached', { ascending: false })
      .limit(LEADERBOARD_LIMIT),
    client
      .from(RECEIPTS_VIEW)
      .select('*')
      .eq('group_slug', slug)
      .order('created_at', { ascending: false })
      .limit(RECENT_RECEIPTS_FETCH_LIMIT),
    client
      .from(RECEIPTS_VIEW)
      .select('*')
      .eq('group_slug', slug)
      .eq('status', 'settled')
      .order('quote_multiplier', { ascending: false })
      .limit(HALL_OF_CALLS_FETCH_LIMIT),
  ]);

  const firstError = leadersRes.error ?? recentRes.error ?? hallRes.error;
  if (firstError) return { ok: false, message: firstError.message };

  const leaderboard = mapRows(leadersRes.data, leaderboardEntryFromRow);
  const recentReceipts = dedupeReceipts(mapRows(recentRes.data, receiptFromRow)).slice(
    0,
    RECENT_RECEIPTS_SHOWN,
  );
  const hallOfCalls = dedupeReceipts(mapRows(hallRes.data, receiptFromRow))
    .filter((receipt) => receipt.outcome !== 'void')
    .slice(0, HALL_OF_CALLS_SIZE);

  // The views expose no groups row directly: a slug with zero presence in
  // both views is either unknown or web-disabled — 404 territory.
  if (leaderboard.length === 0 && recentReceipts.length === 0) {
    return { ok: true, data: null };
  }
  return { ok: true, data: { leaderboard, hallOfCalls, recentReceipts } };
}
