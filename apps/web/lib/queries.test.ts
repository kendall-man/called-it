import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PUBLIC_ESCROW_AGGREGATE_SELECT,
  PUBLIC_ESCROW_CLAIM_SELECT,
  PUBLIC_ESCROW_RECEIPT_SELECT,
  PUBLIC_GROUP_BOARD_SELECT,
  PUBLIC_RECEIPT_SELECT,
  fetchReceipt,
  mergeEscrowOverlays,
} from './queries';
import { assembleEscrowReceipts } from './escrow-receipts';

const PRIVATE_FIELD_TOKENS: ReadonlySet<string> = new Set([
  'accuracy',
  'alias',
  'claimer',
  'display',
  'leaderboard',
  'loss',
  'losses',
  'name',
  'participant',
  'participants',
  'player',
  'players',
  'point',
  'points',
  'position',
  'pubkey',
  'quoted',
  'rank',
  'result',
  'results',
  'score',
  'scores',
  'side',
  'streak',
  'telegram',
  'user',
  'username',
  'wallet',
  'win',
  'winner',
  'winners',
  'wins',
]);

const PUBLIC_AGGREGATE_FIELD_EXCEPTIONS: ReadonlySet<string> = new Set(['position_count']);

const PRIVATE_FIELD_MUTATIONS = [
  'name',
  'quoted',
  'participant_name',
  'winner_name',
  'telegram_user_id',
  'leaderboard_rank',
  'points',
  'total_points',
] as const;

function privateProjectionFields(select: string): readonly string[] {
  return select.split(',').filter((field) => {
    const normalized = field.trim().toLowerCase();
    if (PUBLIC_AGGREGATE_FIELD_EXCEPTIONS.has(normalized)) return false;
    return normalized.split('_').some((token) => PRIVATE_FIELD_TOKENS.has(token));
  });
}

describe('public query projections', () => {
  it('selects only the curated fields needed for public receipts', () => {
    expect(PUBLIC_RECEIPT_SELECT).toContain('merkle_proof');
    expect(privateProjectionFields(PUBLIC_RECEIPT_SELECT)).toEqual([]);
    expect(PUBLIC_RECEIPT_SELECT).not.toMatch(/validate_stat_tx|is_replay/i);
  });

  it('keeps aggregate group-board reads free of participant identities', () => {
    expect(PUBLIC_GROUP_BOARD_SELECT).toContain('matched_amount_lamports');
    expect(PUBLIC_GROUP_BOARD_SELECT).toContain('paid_amount_lamports');
    expect(privateProjectionFields(PUBLIC_GROUP_BOARD_SELECT)).toEqual([]);
  });

  it.each(PRIVATE_FIELD_MUTATIONS)('rejects the private projection field %s', (field) => {
    expect(privateProjectionFields(`market_id,${field}`)).toEqual([field]);
  });

  it('keeps all escrow view projections aggregate-only', () => {
    expect(PUBLIC_ESCROW_RECEIPT_SELECT).toContain('market_pda');
    expect(PUBLIC_ESCROW_RECEIPT_SELECT).toContain('vault_pda');
    expect(PUBLIC_ESCROW_RECEIPT_SELECT).not.toMatch(/owner|destination|provider|telegram|token_hash/i);
    expect(PUBLIC_ESCROW_AGGREGATE_SELECT).not.toMatch(/owner|destination|provider|telegram|wallet/i);
    expect(PUBLIC_ESCROW_CLAIM_SELECT).not.toMatch(/owner|destination|provider|telegram|wallet/i);
  });

  it('merges an escrow overlay by market id without duplicating legacy rows', () => {
    const escrow = assembleEscrowReceipts([], [], []);
    expect(escrow).toEqual([]);
    const legacy = [{ marketId: '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f', status: 'settled' }];
    expect(mergeEscrowOverlays(legacy, [])).toEqual(legacy);
    expect(mergeEscrowOverlays([...legacy, ...legacy], [])).toHaveLength(1);
  });

  it('preserves a legacy receipt when escrow public views are not deployed', async () => {
    const client = fakeClient({
      public_receipts: { data: [legacyReceiptRow()], error: null },
      public_escrow_receipts: { data: null, error: { code: 'PGRST205' } },
    });
    const result = await fetchReceipt(
      client,
      '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f',
    );
    expect(result).toMatchObject({ ok: true, data: { marketId: '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f' } });
    if (result.ok && result.data !== null) expect(result.data.escrow).toBeUndefined();
  });

  it('fails closed when a deployed escrow view returns malformed evidence', async () => {
    const client = fakeClient({
      public_receipts: { data: [legacyReceiptRow()], error: null },
      public_escrow_receipts: { data: [{ market_id: 'not-a-market-id' }], error: null },
      public_escrow_position_aggregates: { data: [], error: null },
      public_escrow_claim_transactions: { data: [], error: null },
    });
    const result = await fetchReceipt(
      client,
      '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f',
    );
    expect(result).toEqual({ ok: false });
  });
});

function fakeClient(results: Readonly<Record<string, { readonly data: unknown; readonly error: unknown }>>): SupabaseClient {
  return {
    from(view: string) {
      const result = results[view] ?? { data: [], error: null };
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'limit', 'order', 'in']) {
        builder[method] = () => builder;
      }
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return builder;
    },
  } as unknown as SupabaseClient;
}

function legacyReceiptRow(): Record<string, unknown> {
  return {
    market_id: '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f',
    group_slug: 'x7kf9q',
    spec: {
      claimType: 'totals_ou',
      fixtureId: 42,
      entityRef: { kind: 'team', participant: 1, name: 'France' },
      comparator: 'gte',
      threshold: 2,
      period: 'FT_90',
      trustTier: 'chain_proven',
    },
    status: 'settled',
    currency: 'sol',
    price_provenance: 'market',
    quote_probability: 0.42,
    quote_multiplier: 2.4,
    back_pot_lamports: '60000000',
    doubt_pot_lamports: '40000000',
    matched_amount_lamports: '80000000',
    refunded_amount_lamports: '20000000',
    paid_amount_lamports: '80000000',
    position_count: 3,
    created_at: '2026-07-10T18:00:00.000Z',
    outcome: 'claim_won',
    deciding_seq: 900,
    evidence_seqs: [880, 900],
    tier: 'chain_proven',
    settled_at: '2026-07-10T19:45:00.000Z',
    proof_status: 'pending',
    explorer_url: null,
    merkle_proof: null,
  };
}
