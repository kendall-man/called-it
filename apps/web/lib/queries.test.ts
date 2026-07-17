import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVNET_ESCROW_PROGRAM_ID } from '@calledit/escrow-sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ESCROW_GENESIS_BY_NETWORK } from './escrow-receipts';
import {
  PUBLIC_ESCROW_AGGREGATE_SELECT,
  PUBLIC_ESCROW_CLAIM_SELECT,
  PUBLIC_ESCROW_RECEIPT_SELECT,
  PUBLIC_GROUP_BOARD_SELECT,
  PUBLIC_RECEIPT_SELECT,
  fetchGroupBoard,
  fetchGroupReceipts,
  fetchReceipt,
} from './queries';

const MARKET_ID = '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f';
const LEGACY_MARKET_ID = '5dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e70';
const OTHER_MARKET_ID = '6dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e71';
const ADDRESS = '11111111111111111111111111111111';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const PRIVATE_FIELD_TOKENS: ReadonlySet<string> = new Set([
  'accuracy',
  'alias',
  'claimer',
  'destination',
  'display',
  'leaderboard',
  'loss',
  'losses',
  'owner',
  'participant',
  'participants',
  'player',
  'players',
  'point',
  'points',
  'provider',
  'pubkey',
  'quoted',
  'rank',
  'score',
  'scores',
  'telegram',
  'token',
  'user',
  'username',
  'wallet',
  'winner',
  'winners',
]);

const ALLOWED_PUBLIC_FIELDS: ReadonlySet<string> = new Set([
  'fixture_p1_name',
  'fixture_p2_name',
  'mint_pubkey',
  'position_count',
]);

const PRIVATE_FIELD_MUTATIONS = [
  'quoted_text',
  'participant_name',
  'owner_pubkey',
  'destination_pubkey',
  'telegram_user_id',
  'provider_user_id',
  'wallet_id',
  'total_points',
] as const;

function privateProjectionFields(select: string): readonly string[] {
  return select.split(',').filter((field) => {
    const normalized = field.trim().toLowerCase();
    if (ALLOWED_PUBLIC_FIELDS.has(normalized)) return false;
    return normalized.split('_').some((token) => PRIVATE_FIELD_TOKENS.has(token));
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'devnet');
  vi.stubEnv('NEXT_PUBLIC_ESCROW_GENESIS_HASH', ESCROW_GENESIS_BY_NETWORK.devnet);
  vi.stubEnv('NEXT_PUBLIC_ESCROW_PROGRAM_ID', DEVNET_ESCROW_PROGRAM_ID);
  vi.stubEnv('NEXT_PUBLIC_ESCROW_CANONICAL_USDC_MINT', USDC_MINT);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('public query projections', () => {
  it('selects every standalone escrow term and no private identity columns', () => {
    const standalone = [
      'fixture_id', 'fixture_p1_name', 'fixture_p2_name', 'spec', 'is_replay', 'kickoff_at',
      'created_at', 'price_provenance', 'quote_probability', 'quote_multiplier',
      'probability_ppm', 'ratio_milli', 'currency', 'genesis_hash', 'mint_pubkey',
      'custody_version', 'chain_state', 'initialize_instruction_index',
      'initialize_block_time', 'settlement_instruction_index', 'status',
    ];
    for (const field of standalone) expect(PUBLIC_ESCROW_RECEIPT_SELECT.split(',')).toContain(field);
    expect(privateProjectionFields(PUBLIC_ESCROW_RECEIPT_SELECT)).toEqual([]);
    expect(PUBLIC_ESCROW_RECEIPT_SELECT).not.toMatch(
      /owner_pubkey|destination_pubkey|participant_name|telegram|provider|quoted_text|token_hash/i,
    );
    expect(PUBLIC_ESCROW_AGGREGATE_SELECT).not.toMatch(/owner|destination|telegram|provider|wallet/i);
    expect(PUBLIC_ESCROW_CLAIM_SELECT).not.toMatch(/owner|destination|telegram|provider|wallet/i);
  });

  it('keeps legacy receipt and board projections aggregate-only', () => {
    expect(PUBLIC_RECEIPT_SELECT).toContain('merkle_proof');
    expect(PUBLIC_RECEIPT_SELECT).not.toMatch(/validate_stat_tx|is_replay/i);
    expect(PUBLIC_GROUP_BOARD_SELECT).toContain('matched_amount_lamports');
    expect(privateProjectionFields(PUBLIC_RECEIPT_SELECT)).toEqual([]);
    expect(privateProjectionFields(PUBLIC_GROUP_BOARD_SELECT)).toEqual([]);
  });

  it.each(PRIVATE_FIELD_MUTATIONS)('detects the private projection field %s', (field) => {
    expect(privateProjectionFields(`market_id,${field}`)).toEqual([field]);
  });
});

describe('standalone escrow receipt queries', () => {
  it('renders an escrow-only live SOL receipt from identity-free aggregates', async () => {
    const client = fakeClient({
      public_receipts: unavailable(),
      public_escrow_receipts: ok([escrowReceiptRow()]),
      public_escrow_position_aggregates: ok([
        aggregateRow({ side: 'back', lot_count: '2', amount_atomic: '10000000' }),
        aggregateRow({ side: 'doubt', lot_count: '3', amount_atomic: '15000000' }),
      ]),
      public_escrow_claim_transactions: ok([]),
    }).client;

    const result = await fetchReceipt(client, MARKET_ID);

    expect(result).toMatchObject({
      ok: true,
      data: {
        marketId: MARKET_ID,
        status: 'open',
        currency: 'sol',
        backPotLamports: '10000000',
        doubtPotLamports: '15000000',
        matchedAmountLamports: '25000000',
        positionCount: 5,
        escrow: { genesisHash: ESCROW_GENESIS_BY_NETWORK.devnet },
      },
    });
    if (result.ok && result.data) expect(result.data.isReplay).toBeUndefined();
  });

  it('renders an escrow-only replay USDC receipt with an explicit replay marker', async () => {
    const client = fakeClient({
      public_receipts: ok([]),
      public_escrow_receipts: ok([escrowReceiptRow({
        asset: 'usdc',
        currency: 'usdc',
        mint_pubkey: USDC_MINT,
        is_replay: true,
        status: 'settled',
        chain_state: 'settled',
        quote_probability: 0.5,
        quote_multiplier: 2,
        probability_ppm: '500000',
        ratio_milli: '1000',
        outcome: 'claim_won',
        settlement_signature: '2'.repeat(64),
        settlement_instruction_index: 1,
        settlement_slot: '200',
        evidence_hash_hex: 'cd'.repeat(32),
        settled_at: '2030-01-01T14:00:00.000Z',
      })]),
      public_escrow_position_aggregates: ok([
        aggregateRow({ asset: 'usdc', side: 'back', amount_atomic: '2000000' }),
        aggregateRow({ asset: 'usdc', side: 'doubt', amount_atomic: '2000000' }),
      ]),
      public_escrow_claim_transactions: ok([
        claimRow({ asset: 'usdc', amount_atomic: '4000000' }),
      ]),
    }).client;

    const result = await fetchReceipt(client, MARKET_ID);

    expect(result).toMatchObject({
      ok: true,
      data: {
        isReplay: true,
        currency: 'usdc',
        status: 'settled',
        paidAmountLamports: '4000000',
        escrow: { mintPubkey: USDC_MINT },
      },
    });
  });

  it('configuration-gates mainnet rows and does not silently trust their identity columns', async () => {
    const client = fakeClient({
      public_receipts: ok([]),
      public_escrow_receipts: ok([escrowReceiptRow({
        cluster: 'mainnet-beta',
        genesis_hash: ESCROW_GENESIS_BY_NETWORK['mainnet-beta'],
      })]),
    }).client;

    await expect(fetchReceipt(client, MARKET_ID)).resolves.toEqual({ ok: false });
  });
});

describe('legacy and mixed source behavior', () => {
  it('preserves a legacy-only receipt when escrow public views are unavailable', async () => {
    const client = fakeClient({
      public_receipts: ok([legacyReceiptRow()]),
      public_escrow_receipts: unavailable(),
    }).client;
    const result = await fetchReceipt(client, LEGACY_MARKET_ID);
    expect(result).toMatchObject({ ok: true, data: { marketId: LEGACY_MARKET_ID } });
    if (result.ok && result.data !== null) expect(result.data.escrow).toBeUndefined();
  });

  it('merges a mixed group for both receipts and the aggregate board', async () => {
    const results = {
      public_receipts: ok([legacyReceiptRow()]),
      public_group_board: ok([legacyReceiptRow()]),
      public_escrow_receipts: ok([escrowReceiptRow()]),
      public_escrow_position_aggregates: ok([
        aggregateRow({ side: 'back', amount_atomic: '10000000' }),
        aggregateRow({ side: 'doubt', amount_atomic: '15000000' }),
      ]),
      public_escrow_claim_transactions: ok([]),
    };

    const receipts = await fetchGroupReceipts(fakeClient(results).client, 'called-it-testers');
    const board = await fetchGroupBoard(fakeClient(results).client, 'called-it-testers');

    expect(receipts.ok && receipts.data?.map((row) => row.marketId)).toEqual([
      MARKET_ID,
      LEGACY_MARKET_ID,
    ]);
    expect(board.ok && board.data?.map((row) => row.marketId)).toEqual([
      MARKET_ID,
      LEGACY_MARKET_ID,
    ]);
    if (board.ok) expect(board.data?.[0]).toHaveProperty('escrow');
  });

  it('dedupes a compatible legacy/escrow market and uses escrow aggregate totals', async () => {
    const client = fakeClient({
      public_receipts: ok([legacyMatchingEscrowRow()]),
      public_escrow_receipts: ok([escrowReceiptRow()]),
      public_escrow_position_aggregates: ok([
        aggregateRow({ side: 'back', amount_atomic: '10000000' }),
        aggregateRow({ side: 'doubt', amount_atomic: '15000000' }),
      ]),
      public_escrow_claim_transactions: ok([]),
    }).client;

    const result = await fetchReceipt(client, MARKET_ID);

    expect(result).toMatchObject({
      ok: true,
      data: {
        marketId: MARKET_ID,
        backPotLamports: '10000000',
        doubtPotLamports: '15000000',
        escrow: { marketId: MARKET_ID },
      },
    });
  });

  it('rejects contradictory legacy/escrow rows and conflicting escrow duplicates', async () => {
    const contradictory = fakeClient({
      public_receipts: ok([legacyMatchingEscrowRow({ group_slug: 'another-group' })]),
      public_escrow_receipts: ok([escrowReceiptRow()]),
      public_escrow_position_aggregates: ok([]),
      public_escrow_claim_transactions: ok([]),
    }).client;
    const duplicate = fakeClient({
      public_receipts: ok([]),
      public_escrow_receipts: ok([
        escrowReceiptRow(),
        escrowReceiptRow({ vault_pda: 'Vote111111111111111111111111111111111111111' }),
      ]),
      public_escrow_position_aggregates: ok([]),
      public_escrow_claim_transactions: ok([]),
    }).client;

    await expect(fetchReceipt(contradictory, MARKET_ID)).resolves.toEqual({ ok: false });
    await expect(fetchReceipt(duplicate, MARKET_ID)).resolves.toEqual({ ok: false });
  });
});

describe('malformed auxiliary data degradation', () => {
  it.each([
    {
      name: 'missing aggregate data',
      aggregates: ok(null),
      claims: ok([]),
    },
    {
      name: 'malformed aggregate identity',
      aggregates: ok([aggregateRow({ market_id: OTHER_MARKET_ID })]),
      claims: ok([]),
    },
    {
      name: 'missing claim data',
      aggregates: ok([]),
      claims: ok(null),
    },
    {
      name: 'malformed claim identity',
      aggregates: ok([]),
      claims: ok([claimRow({ claim_signature: 'not-a-signature' })]),
    },
  ])('returns a typed unavailable state for $name without throwing', async ({ aggregates, claims }) => {
    const client = fakeClient({
      public_receipts: ok([]),
      public_escrow_receipts: ok([escrowReceiptRow()]),
      public_escrow_position_aggregates: aggregates,
      public_escrow_claim_transactions: claims,
    }).client;

    await expect(fetchReceipt(client, MARKET_ID)).resolves.toEqual({ ok: false });
  });

  it('falls back to legacy data when an auxiliary escrow view is unavailable', async () => {
    const client = fakeClient({
      public_receipts: ok([legacyReceiptRow()]),
      public_escrow_receipts: ok([escrowReceiptRow({ market_id: LEGACY_MARKET_ID })]),
      public_escrow_position_aggregates: unavailable(),
      public_escrow_claim_transactions: ok([]),
    }).client;

    const result = await fetchReceipt(client, LEGACY_MARKET_ID);
    expect(result).toMatchObject({ ok: true, data: { marketId: LEGACY_MARKET_ID } });
  });
});

type FakeResult = { readonly data: unknown; readonly error: unknown };

function ok(data: unknown): FakeResult {
  return { data, error: null };
}

function unavailable(): FakeResult {
  return { data: null, error: { code: 'PGRST205' } };
}

function fakeClient(results: Readonly<Record<string, FakeResult>>): {
  readonly client: SupabaseClient;
  readonly selections: Readonly<Record<string, readonly string[]>>;
} {
  const selections: Record<string, string[]> = {};
  const client = {
    from(view: string) {
      const result = results[view] ?? ok([]);
      const builder: Record<string, unknown> = {};
      builder.select = (projection: string) => {
        (selections[view] ??= []).push(projection);
        return builder;
      };
      for (const method of ['eq', 'limit', 'order', 'in']) builder[method] = () => builder;
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, selections };
}

function legacyReceiptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market_id: LEGACY_MARKET_ID,
    group_slug: 'called-it-testers',
    spec: {
      claimType: 'totals_ou',
      fixtureId: 84,
      entityRef: { kind: 'team', participant: 1, name: 'Legacy FC' },
      comparator: 'gte',
      threshold: 2,
      period: 'FT_90',
      trustTier: 'chain_proven',
    },
    status: 'settled',
    currency: 'sol',
    price_provenance: 'market',
    quote_probability: 0.5,
    quote_multiplier: 2,
    back_pot_lamports: '60000000',
    doubt_pot_lamports: '40000000',
    matched_amount_lamports: '80000000',
    refunded_amount_lamports: '20000000',
    paid_amount_lamports: '80000000',
    position_count: 3,
    created_at: '2029-11-01T18:00:00.000Z',
    outcome: 'claim_won',
    deciding_seq: 900,
    evidence_seqs: [880, 900],
    tier: 'chain_proven',
    settled_at: '2029-11-01T19:45:00.000Z',
    proof_status: 'pending',
    explorer_url: null,
    merkle_proof: null,
    ...overrides,
  };
}

function legacyMatchingEscrowRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return legacyReceiptRow({
    market_id: MARKET_ID,
    spec: marketSpec(),
    status: 'open',
    quote_probability: 0.4,
    quote_multiplier: 2.5,
    created_at: '2029-12-01T00:00:00.000Z',
    outcome: null,
    deciding_seq: null,
    evidence_seqs: null,
    tier: null,
    settled_at: null,
    proof_status: null,
    ...overrides,
  });
}

function escrowReceiptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market_id: MARKET_ID,
    group_slug: 'called-it-testers',
    web_enabled: true,
    cluster: 'devnet',
    program_id: DEVNET_ESCROW_PROGRAM_ID,
    market_pda: ADDRESS,
    vault_pda: ADDRESS,
    asset: 'sol',
    document_hash_hex: 'ab'.repeat(32),
    initialize_signature: '1'.repeat(64),
    initialize_slot: '100',
    outcome: null,
    settlement_signature: null,
    settlement_slot: null,
    evidence_hash_hex: null,
    settled_at: null,
    fixture_id: 42,
    fixture_p1_name: 'North FC',
    fixture_p2_name: 'South FC',
    spec: marketSpec(),
    is_replay: false,
    kickoff_at: '2030-01-01T12:00:00.000Z',
    created_at: '2029-12-01T00:00:00.000Z',
    price_provenance: 'market',
    quote_probability: 0.4,
    quote_multiplier: 2.5,
    probability_ppm: '400000',
    ratio_milli: '1500',
    currency: 'sol',
    genesis_hash: ESCROW_GENESIS_BY_NETWORK.devnet,
    mint_pubkey: null,
    custody_version: 1,
    chain_state: 'open',
    initialize_instruction_index: 0,
    initialize_block_time: '2029-12-01T00:01:00.000Z',
    settlement_instruction_index: null,
    status: 'open',
    ...overrides,
  };
}

function aggregateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market_id: MARKET_ID,
    cluster: 'devnet',
    asset: 'sol',
    side: 'back',
    state: 'active',
    lot_count: '1',
    amount_atomic: '10000000',
    ...overrides,
  };
}

function claimRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market_id: MARKET_ID,
    cluster: 'devnet',
    claim_signature: '3'.repeat(64),
    claim_slot: '300',
    claimed_at: '2030-01-01T14:01:00.000Z',
    asset: 'sol',
    claim_kind: 'payout',
    recipient_count: '1',
    amount_atomic: '19000000',
    ...overrides,
  };
}

function marketSpec(): Record<string, unknown> {
  return {
    claimType: 'match_winner',
    fixtureId: 42,
    entityRef: { kind: 'team', participant: 1, name: 'North FC' },
    comparator: 'eq',
    threshold: 1,
    period: 'FT',
    trustTier: 'chain_proven',
  };
}
