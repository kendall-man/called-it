import { describe, expect, it } from 'vitest';
import {
  describeEvidenceFact,
  evidenceFromRow,
  groupBoardMarketFromRow,
  isPublicMarketId,
  receiptFromRow,
  type PublicGroupBoardMarket,
  type PublicReceipt,
} from './receipts';
import { formatLamportsAsSol } from './format';

function viewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    validate_stat_tx: null,
    ...overrides,
  };
}

function mustMapBoard(row: Record<string, unknown>): PublicGroupBoardMarket {
  const mapped = groupBoardMarketFromRow(row);
  expect(mapped).not.toBeNull();
  if (!mapped) throw new Error('Expected a public group-board row');
  return mapped;
}

function mustMap(row: Record<string, unknown>): PublicReceipt {
  const mapped = receiptFromRow(row);
  expect(mapped).not.toBeNull();
  return mapped as PublicReceipt;
}

describe('receiptFromRow', () => {
  it('accepts canonical five-segment receipt UUIDs and rejects malformed route ids', () => {
    expect(isPublicMarketId('27604aa1-39a7-4e0c-8a07-25ec1f560b25')).toBe(true);
    expect(isPublicMarketId('27604aa1-39a7-4e0c-25ec1f560b25')).toBe(false);
  });

  it('maps a complete privacy-safe view row', () => {
    const receipt = mustMap(viewRow());
    expect(receipt.marketId).toBe('4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f');
    expect(receipt.evidenceSeqs).toEqual([880, 900]);
    expect(receipt.tier).toBe('chain_proven');
    expect(receipt.proofStatus).toBe('pending');
    expect(receipt.currency).toBe('sol');
    expect(receipt).toMatchObject({
      terms: {
        text: '2 goals or more in the match',
        period: 'In 90 minutes — extra time and shootouts don’t count',
        trustTier: 'chain_proven',
      },
      backPotLamports: '60000000',
      doubtPotLamports: '40000000',
      matchedAmountLamports: '80000000',
      refundedAmountLamports: '20000000',
      paidAmountLamports: '80000000',
      positionCount: 3,
    });
  });

  it('accepts only public SOL receipt rows', () => {
    expect(mustMap(viewRow({ currency: 'sol' })).currency).toBe('sol');
    expect(receiptFromRow(viewRow({ currency: 'rep' }))).toBeNull();
    expect(receiptFromRow(viewRow({ currency: 'doubloons' }))).toBeNull();
    expect(receiptFromRow(viewRow({ currency: undefined }))).toBeNull();
  });

  it('never maps raw quote or identity fallbacks from a mixed view row', () => {
    const receipt = mustMap(
      viewRow({
        quoted_text: 'PRIVATE CLAIM @sentinel_user',
        claimer_name: 'Private Telegram Name',
        username: '@sentinel_user',
        validate_stat_tx: 'private-public-key-like-value',
      }),
    );

    expect(receipt).not.toHaveProperty('quotedText');
    expect(receipt).not.toHaveProperty('claimerName');
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE CLAIM');
    expect(JSON.stringify(receipt)).not.toContain('@sentinel_user');
    expect(JSON.stringify(receipt)).not.toContain('Private Telegram Name');
    expect(JSON.stringify(receipt)).not.toContain('private-public-key-like-value');
  });

  it('never maps a participant alias from a mixed view row', () => {
    const receipt = mustMap(viewRow({ claimer_alias: 'Player DEADBEEF' }));

    expect(receipt).not.toHaveProperty('claimerAlias');
    expect(JSON.stringify(receipt)).not.toContain('Player DEADBEEF');
  });

  it('does not expose the replay marker even when a mixed row carries it', () => {
    const receipt = mustMap(viewRow({ is_replay: true }));

    expect(receipt).not.toHaveProperty('isReplay');
    expect(JSON.stringify(receipt)).not.toContain('isReplay');
  });

  it('rejects rows without a complete aggregate contract', () => {
    expect(receiptFromRow(viewRow({ matched_amount_lamports: null }))).toBeNull();
    expect(receiptFromRow(viewRow({ position_count: 'three' }))).toBeNull();
  });

  it('tolerates an unsettled market (all settlement columns null)', () => {
    const receipt = mustMap(
      viewRow({
        status: 'open',
        outcome: null,
        deciding_seq: null,
        evidence_seqs: null,
        tier: null,
        settled_at: null,
        proof_status: null,
      }),
    );
    expect(receipt.outcome).toBeNull();
    expect(receipt.evidenceSeqs).toEqual([]);
  });

  it('rejects rows missing required columns', () => {
    expect(receiptFromRow(viewRow({ market_id: null }))).toBeNull();
    expect(receiptFromRow(viewRow({ status: 'imaginary' }))).toBeNull();
    expect(receiptFromRow(viewRow({ quote_multiplier: 'x9' }))).toBeNull();
    expect(receiptFromRow(viewRow({ spec: { claimType: 'totals_ou' } }))).toBeNull();
    expect(receiptFromRow(viewRow({ deciding_seq: -1 }))).toBeNull();
    expect(receiptFromRow(viewRow({ evidence_seqs: [900, '901'] }))).toBeNull();
  });
});

describe('groupBoardMarketFromRow', () => {
  it('maps exact public SOL aggregates without any identity fields', () => {
    const market = mustMapBoard(
      viewRow({
        refunded_amount_lamports: '20000000',
        paid_amount_lamports: '80000000',
        position_count: 3,
        claimer_alias: undefined,
        quoted_text: 'PRIVATE CLAIM @sentinel_user',
        claimer_name: 'Private Telegram Name',
        wallet: 'Private wallet address',
      }),
    );

    expect(market).toMatchObject({
      backPotLamports: '60000000',
      doubtPotLamports: '40000000',
      matchedAmountLamports: '80000000',
      refundedAmountLamports: '20000000',
      paidAmountLamports: '80000000',
      positionCount: 3,
    });
    expect(JSON.stringify(market)).not.toContain('PRIVATE CLAIM');
    expect(JSON.stringify(market)).not.toContain('Private Telegram Name');
    expect(JSON.stringify(market)).not.toContain('wallet address');
    expect(market).not.toHaveProperty('claimerAlias');
  });

  it('rejects a non-SOL or incomplete aggregate row', () => {
    expect(groupBoardMarketFromRow(viewRow({ currency: 'rep' }))).toBeNull();
    expect(groupBoardMarketFromRow(viewRow({ paid_amount_lamports: null }))).toBeNull();
  });
});

describe('formatLamportsAsSol', () => {
  it('formats decimal lamports without converting an unsafe bigint to a number', () => {
    expect(formatLamportsAsSol('90071992547409930000000000')).toBe('90,071,992,547,409,930 SOL');
    expect(formatLamportsAsSol('10000001')).toBe('0.010000001 SOL');
  });
});

describe('evidenceFromRow', () => {
  it('maps derived facts', () => {
    expect(
      evidenceFromRow({
        fixture_id: 42,
        seq: 900,
        kind: 'goal',
        confirmed: true,
        minute: 67,
        goal_type: 'penalty',
      }),
    ).toEqual({
      fixtureId: 42,
      seq: 900,
      kind: 'goal',
      confirmed: true,
      minute: 67,
      goalType: 'penalty',
    });
  });

  it('rejects rows without identity columns', () => {
    expect(evidenceFromRow({ seq: 900, kind: 'goal' })).toBeNull();
  });

  it('renders only allowlisted public event copy', () => {
    expect(
      describeEvidenceFact({
        fixtureId: 42,
        seq: 900,
        kind: 'goal',
        confirmed: true,
        minute: 67,
        goalType: 'penalty',
      }),
    ).toBe('Goal (from the spot)');
    expect(
      describeEvidenceFact({
        fixtureId: 42,
        seq: 901,
        kind: 'upstream_provider_private_code',
        confirmed: false,
        minute: null,
        goalType: null,
      }),
    ).toBe('Verified match event');
  });
});
