import { describe, expect, it } from 'vitest';
import {
  dedupeReceipts,
  evidenceFromRow,
  leaderboardEntryFromRow,
  pickBestReceiptRow,
  receiptFromRow,
  type PublicReceipt,
} from './receipts';

function viewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market_id: '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f',
    group_slug: 'x7kf9q',
    quoted_text: 'over 2.5 easy',
    claimer_name: 'Chris',
    spec: { claimType: 'totals_ou' },
    status: 'settled',
    is_replay: false,
    price_provenance: 'market',
    quote_probability: 0.42,
    quote_multiplier: 2.4,
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

function mustMap(row: Record<string, unknown>): PublicReceipt {
  const mapped = receiptFromRow(row);
  expect(mapped).not.toBeNull();
  return mapped as PublicReceipt;
}

describe('receiptFromRow', () => {
  it('maps a complete view row', () => {
    const receipt = mustMap(viewRow());
    expect(receipt.marketId).toBe('4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f');
    expect(receipt.evidenceSeqs).toEqual([880, 900]);
    expect(receipt.tier).toBe('chain_proven');
    expect(receipt.proofStatus).toBe('pending');
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
  });
});

describe('proof fan-out collapsing', () => {
  it('prefers the verified proof row for one market', () => {
    const rows = [
      mustMap(viewRow({ proof_status: 'pending' })),
      mustMap(viewRow({ proof_status: 'verified', explorer_url: 'https://explorer/tx' })),
      mustMap(viewRow({ proof_status: 'failed' })),
    ];
    const best = pickBestReceiptRow(rows);
    expect(best?.proofStatus).toBe('verified');
    expect(best?.explorerUrl).toBe('https://explorer/tx');
  });

  it('dedupes multi-market lists preserving order', () => {
    const marketA = viewRow();
    const marketB = viewRow({ market_id: '99999999-2f1e-4bc5-9b43-1a2b3c4d5e6f' });
    const deduped = dedupeReceipts([
      mustMap(viewRow({ proof_status: null })),
      mustMap(marketB),
      mustMap(viewRow({ proof_status: 'verified' })),
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.marketId).toBe(marketA.market_id);
    expect(deduped[0]?.proofStatus).toBe('verified');
  });

  it('returns null for an empty set', () => {
    expect(pickBestReceiptRow([])).toBeNull();
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
        player_name: 'Mbappé',
        goal_type: 'penalty',
      }),
    ).toEqual({
      fixtureId: 42,
      seq: 900,
      kind: 'goal',
      confirmed: true,
      minute: 67,
      playerName: 'Mbappé',
      goalType: 'penalty',
    });
  });

  it('rejects rows without identity columns', () => {
    expect(evidenceFromRow({ seq: 900, kind: 'goal' })).toBeNull();
  });
});

describe('leaderboardEntryFromRow', () => {
  it('maps and defaults streak', () => {
    expect(
      leaderboardEntryFromRow({ display_name: 'Chris', points_cached: 1250, streak: null }),
    ).toEqual({ displayName: 'Chris', points: 1250, streak: 0 });
  });

  it('rejects incomplete rows', () => {
    expect(leaderboardEntryFromRow({ display_name: 'Chris' })).toBeNull();
  });
});
