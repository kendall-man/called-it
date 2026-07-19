import { describe, expect, it } from 'vitest';
import { queryDbResponses, type QueryCall } from './group-points-test-support.js';

const GROUP_ID = -100_123;
const MARKET_ID = 'a3bb189e-8bf9-4888-9912-ace4e6543002';
const HASH = 'a'.repeat(64);

function unavailableView() {
  return { data: null, error: { code: 'PGRST205', message: 'relation unavailable' } };
}

function canonicalResponses(options: {
  readonly crossSide?: boolean;
  readonly missingAccount?: boolean;
  readonly missingLink?: boolean;
} = {}) {
  const second = options.crossSide === true;
  return [
    unavailableView(),
    { data: [{ id: GROUP_ID, points_started_at: '2026-01-01T00:00:00.000Z' }], error: null },
    {
      data: [{ id: MARKET_ID, custody_mode: 'escrow', is_replay: false, currency: 'sol', status: 'settled' }],
      error: null,
    },
    { data: [], error: null },
    { data: [{ market_id: MARKET_ID, group_id: GROUP_ID }], error: null },
    {
      data: options.missingLink === true ? [] : [{
        market_id: MARKET_ID, program_id: 'program', document_hash_hex: HASH,
        chain_state: 'settled', cluster: 'devnet', commitment: 'finalized',
        canonical: true, projection_stale: false,
      }],
      error: null,
    },
    {
      data: [{
        market_id: MARKET_ID, outcome: 'claim_won', tier: 'chain_proven',
        settled_at: '2026-01-02T00:00:00.000Z',
      }],
      error: null,
    },
    {
      data: [{
        market_id: MARKET_ID, program_id: 'program', document_hash_hex: HASH,
        outcome: 'claim_won', block_time: '2026-01-02T00:00:00.000Z',
        observed_at: '2026-01-02T00:00:01.000Z', commitment: 'finalized', canonical: true,
      }],
      error: null,
    },
    {
      data: [
        lot('owner-a', '0', 'back', 'sig-a', 0),
        ...(second ? [lot('owner-b', '0', 'doubt', 'sig-b', 1)] : []),
      ],
      error: null,
    },
    {
      data: options.missingAccount === true ? [] : [
        account('owner-a', 'back'), ...(second ? [account('owner-b', 'doubt')] : []),
      ],
      error: null,
    },
    {
      data: [
        placed('owner-a', '0', 'back', 'sig-a', 0),
        ...(second ? [placed('owner-b', '0', 'doubt', 'sig-b', 1)] : []),
      ],
      error: null,
    },
    {
      data: [
        session(7001, 'owner-a', '0', 'back', 'sig-a'),
        ...(second ? [session(7001, 'owner-b', '0', 'doubt', 'sig-b')] : []),
      ],
      error: null,
    },
    ...(!second ? [{
      data: [{ id: 7001, display_name: 'Alice', username: 'alice_calls' }],
      error: null,
    }] : []),
  ];
}

function lot(owner: string, nonce: string, side: 'back' | 'doubt', signature: string, index: number, marketId = MARKET_ID) {
  return {
    market_id: marketId, owner_pubkey: owner, lot_nonce: nonce, position_pda: `position-${owner}`,
    side, asset: 'sol', amount_atomic: '20000000', event_epoch: '0', state: 'active',
    placed_signature: signature, placed_instruction_index: index,
    commitment: 'finalized', canonical: true,
  };
}

function account(owner: string, side: 'back' | 'doubt', marketId = MARKET_ID) {
  return {
    market_id: marketId, owner_pubkey: owner, position_pda: `position-${owner}`,
    side, asset: 'sol', deposited_atomic: '20000000', commitment: 'finalized', canonical: true,
  };
}

function placed(owner: string, nonce: string, side: 'back' | 'doubt', signature: string, index: number, marketId = MARKET_ID) {
  return {
    signature, instruction_index: index, market_id: marketId, owner_pubkey: owner,
    lot_nonce: nonce, position_pda: `position-${owner}`, event_kind: 'placed', side,
    asset: 'sol', amount_atomic: '20000000', event_epoch: '0',
    commitment: 'finalized', canonical: true,
  };
}

function session(userId: number, owner: string, nonce: string, side: 'back' | 'doubt', signature: string, marketId = MARKET_ID) {
  return {
    user_id: userId, transaction_signature: signature, market_id: marketId,
    owner_pubkey: owner, lot_nonce: nonce, side, asset: 'sol', amount_atomic: '20000000',
    event_epoch: '0', document_hash_hex: HASH, state: 'consumed',
    consumed_at: '2026-01-01T23:59:00.000Z',
  };
}

describe('migration-independent canonical group stats fallback', () => {
  it('scores only an exact immutable signing-session identity over finalized canonical truth', async () => {
    const calls: QueryCall[] = [];
    const db = queryDbResponses(canonicalResponses(), calls);

    await expect(db.leaderboard(GROUP_ID, 10)).resolves.toEqual([{
      group_id: GROUP_ID,
      user_id: 7001,
      points: 10,
      wins: 1,
      losses: 0,
      accuracy: 1,
      current_streak: 1,
      best_streak: 1,
      display_name: 'Alice',
      username: 'alice_calls',
    }]);
    const tables = calls.filter((call) => call.method === 'from').map((call) => call.args[0]);
    expect(tables).toContain('escrow_signing_sessions');
    expect(tables).not.toContain('wager_wallet_links');
    expect(tables).not.toContain('positions');
    expect(calls).toContainEqual({ method: 'eq', args: ['is_replay', false] });
    expect(calls).toContainEqual({ method: 'eq', args: ['commitment', 'finalized'] });
    expect(calls).toContainEqual({ method: 'eq', args: ['canonical', true] });
  });

  it('keeps the player-stats response inside its declared non-identity contract', async () => {
    const db = queryDbResponses(canonicalResponses());
    const stats = await db.groupPlayerStats(GROUP_ID, 7001);

    expect(stats).toEqual({
      group_id: GROUP_ID,
      user_id: 7001,
      points: 10,
      wins: 1,
      losses: 0,
      accuracy: 1,
      current_streak: 1,
      best_streak: 1,
    });
    expect(stats).not.toHaveProperty('display_name');
    expect(stats).not.toHaveProperty('username');
  });

  it('fails closed when one immutable user identity appears on both sides', async () => {
    const db = queryDbResponses(canonicalResponses({ crossSide: true }));
    await expect(db.leaderboard(GROUP_ID, 10)).rejects.toThrow(
      'database contract violation at position_conflict',
    );
  });

  it('fails closed when a bounded canonical query would be truncated', async () => {
    const db = queryDbResponses([
      unavailableView(),
      { data: [{ id: GROUP_ID, points_started_at: '2026-01-01T00:00:00.000Z' }], error: null },
      {
        data: [{ id: MARKET_ID, custody_mode: 'legacy', is_replay: false, currency: 'sol', status: 'settled' }],
        error: null,
      },
      {
        data: Array.from({ length: 1_000 }, (_, index) => ({
          market_id: MARKET_ID, user_id: index + 1, side: 'back', result: 'won',
          points_delta: 10, settled_at: '2026-01-02T00:00:00.000Z',
        })),
        error: null,
      },
    ]);
    await expect(db.leaderboard(GROUP_ID, 10)).rejects.toThrow(
      'database contract violation at persisted_events_bound',
    );
  });

  it('prefers a persisted canonical escrow score after lot and account cleanup', async () => {
    const db = queryDbResponses([
      unavailableView(),
      { data: [{ id: GROUP_ID, points_started_at: '2026-01-01T00:00:00.000Z' }], error: null },
      { data: [{ id: MARKET_ID, custody_mode: 'escrow', is_replay: false, currency: 'sol', status: 'settled' }], error: null },
      { data: [{ market_id: MARKET_ID, user_id: 7001, side: 'back', result: 'won', points_delta: 10, settled_at: '2026-01-02T00:00:00.000Z' }], error: null },
      { data: [], error: null },
      { data: [{ market_id: MARKET_ID, program_id: 'program', document_hash_hex: HASH, chain_state: 'settled', cluster: 'devnet', commitment: 'finalized', canonical: true, projection_stale: false }], error: null },
      { data: [{ market_id: MARKET_ID, outcome: 'claim_won', tier: 'chain_proven', settled_at: '2026-01-02T00:00:00.000Z' }], error: null },
      { data: [{ market_id: MARKET_ID, program_id: 'program', document_hash_hex: HASH, outcome: 'claim_won', block_time: '2026-01-02T00:00:01.000Z', observed_at: '2026-01-02T00:00:02.000Z', commitment: 'finalized', canonical: true }], error: null },
      { data: [{ id: 7001, display_name: 'Alice', username: null }], error: null },
    ]);

    await expect(db.leaderboard(GROUP_ID, 10)).resolves.toMatchObject([{
      user_id: 7001, points: 10, wins: 1, losses: 0,
    }]);
  });

  it('keeps persisted oracle-resolved score events authoritative without chain projections', async () => {
    const db = queryDbResponses([
      unavailableView(),
      { data: [{ id: GROUP_ID, points_started_at: '2026-01-01T00:00:00.000Z' }], error: null },
      { data: [{ id: MARKET_ID, custody_mode: 'escrow', is_replay: false, currency: 'sol', status: 'settled' }], error: null },
      { data: [{ market_id: MARKET_ID, user_id: 7001, side: 'doubt', result: 'won', points_delta: 10, settled_at: '2026-01-02T00:00:00.000Z' }], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [{ market_id: MARKET_ID, outcome: 'claim_lost', tier: 'oracle_resolved', settled_at: '2026-01-02T00:00:00.000Z' }], error: null },
      { data: [], error: null },
      { data: [{ id: 7001, display_name: 'Alice', username: null }], error: null },
    ]);

    await expect(db.leaderboard(GROUP_ID, 10)).resolves.toMatchObject([{
      user_id: 7001, points: 10, wins: 1, losses: 0,
    }]);
  });

  it('fails closed instead of undercounting a finalized lot with no exact account projection', async () => {
    const db = queryDbResponses(canonicalResponses({ missingAccount: true }));
    await expect(db.leaderboard(GROUP_ID, 10)).rejects.toThrow(
      'database contract violation at position_account',
    );
  });

  it('fails closed when a chain-proven DB settlement lacks its finalized market link', async () => {
    const db = queryDbResponses(canonicalResponses({ missingLink: true }));
    await expect(db.leaderboard(GROUP_ID, 10)).rejects.toThrow(
      'database contract violation at market_link',
    );
  });

  it('fails closed on contradictory persisted identities for one market and user', async () => {
    const db = queryDbResponses([
      unavailableView(),
      { data: [{ id: GROUP_ID, points_started_at: '2026-01-01T00:00:00.000Z' }], error: null },
      { data: [{ id: MARKET_ID, custody_mode: 'escrow', is_replay: false, currency: 'sol', status: 'settled' }], error: null },
      {
        data: [
          { market_id: MARKET_ID, user_id: 7001, side: 'back', result: 'won', points_delta: 10, settled_at: '2026-01-02T00:00:00.000Z' },
          { market_id: MARKET_ID, user_id: 7001, side: 'doubt', result: 'lost', points_delta: 0, settled_at: '2026-01-02T00:00:00.000Z' },
        ],
        error: null,
      },
    ]);
    await expect(db.leaderboard(GROUP_ID, 10)).rejects.toThrow(
      'database contract violation at score_event',
    );
  });

  it('uses canonical settlement time and market id for stable streak ordering', async () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    const markets = [first, second];
    const db = queryDbResponses([
      unavailableView(),
      { data: [{ id: GROUP_ID, points_started_at: '2026-01-01T00:00:00.000Z' }], error: null },
      {
        data: markets.map((id) => ({ id, custody_mode: 'escrow', is_replay: false, currency: 'sol', status: 'settled' })),
        error: null,
      },
      { data: [], error: null },
      { data: markets.map((market_id) => ({ market_id, group_id: GROUP_ID })), error: null },
      {
        data: [...markets].reverse().map((market_id) => ({
          market_id, program_id: 'program', document_hash_hex: HASH, chain_state: 'settled',
          cluster: 'devnet', commitment: 'finalized', canonical: true, projection_stale: false,
        })),
        error: null,
      },
      {
        data: [
          { market_id: second, outcome: 'claim_won', tier: 'chain_proven', settled_at: '2026-01-02T00:00:00.000Z' },
          { market_id: first, outcome: 'claim_lost', tier: 'chain_proven', settled_at: '2026-01-03T00:00:00.000Z' },
        ],
        error: null,
      },
      {
        data: [
          { market_id: second, program_id: 'program', document_hash_hex: HASH, outcome: 'claim_won', block_time: '2026-01-02T00:00:00.000Z', observed_at: '2026-01-02T00:00:01.000Z', commitment: 'finalized', canonical: true },
          { market_id: first, program_id: 'program', document_hash_hex: HASH, outcome: 'claim_lost', block_time: '2026-01-02T00:00:00.000Z', observed_at: '2026-01-02T00:00:01.000Z', commitment: 'finalized', canonical: true },
        ],
        error: null,
      },
      { data: [lot('owner-2', '0', 'back', 'sig-2', 0, second), lot('owner-1', '0', 'back', 'sig-1', 0, first)], error: null },
      { data: [account('owner-2', 'back', second), account('owner-1', 'back', first)], error: null },
      { data: [placed('owner-2', '0', 'back', 'sig-2', 0, second), placed('owner-1', '0', 'back', 'sig-1', 0, first)], error: null },
      { data: [session(7001, 'owner-2', '0', 'back', 'sig-2', second), session(7001, 'owner-1', '0', 'back', 'sig-1', first)], error: null },
      { data: [{ id: 7001, display_name: 'Alice', username: null }], error: null },
    ]);

    await expect(db.leaderboard(GROUP_ID, 10)).resolves.toMatchObject([{
      points: 10,
      wins: 1,
      losses: 1,
      current_streak: 0,
      best_streak: 1,
    }]);
  });

  it('does not reconstruct an escrow score before group-points application commits', async () => {
    const responses = canonicalResponses();
    const withoutApplied = responses.map((response, index) => (
      index === 4 ? { data: [], error: null } : response
    ));
    const db = queryDbResponses(withoutApplied);

    await expect(db.leaderboard(GROUP_ID, 10)).resolves.toEqual([]);
  });

  it('fails closed when an exact count proves the server truncated a bounded response', async () => {
    const db = queryDbResponses([
      unavailableView(),
      {
        data: [{ id: GROUP_ID, points_started_at: '2026-01-01T00:00:00.000Z' }],
        error: null,
        count: 1,
      },
      {
        data: [{ id: MARKET_ID, custody_mode: 'legacy', is_replay: false, currency: 'sol', status: 'settled' }],
        error: null,
        count: 2,
      },
    ]);

    await expect(db.leaderboard(GROUP_ID, 10)).rejects.toThrow(
      'database contract violation at markets_truncated',
    );
  });
});
