import { describe, expect, it } from 'vitest';
import {
  MARKET_ID,
  queryDbResponses,
  type QueryCall,
} from './group-points-test-support.js';

const participantRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  market_id: MARKET_ID,
  user_id: 7001,
  side: 'back',
  placed_at_ms: 1_720_000_000_001,
  market: { id: MARKET_ID, group_id: -100_123 },
  user: { display_name: 'Alice', username: 'alice_calls' },
  ...overrides,
});

describe('group point participant queries', () => {
  it('uses bounded joined side queries for non-void participants', async () => {
    // Given interleaved side responses with one repeated user and side placement
    const calls: QueryCall[] = [];
    const db = queryDbResponses(
      [
        {
          data: [
            participantRow({ placed_at_ms: 1_720_000_000_002 }),
            participantRow({ placed_at_ms: 1_720_000_000_003 }),
          ],
          error: null,
        },
        {
          data: [
            participantRow({
              user_id: 7002,
              side: 'doubt',
              placed_at_ms: 1_720_000_000_001,
              user: { display_name: 'Bob', username: null },
            }),
          ],
          error: null,
        },
      ],
      calls,
    );

    // When participants are loaded for one market
    const participants = await db.positionParticipantsForMarket(MARKET_ID);

    // Then pending/active pass, void cannot, and no per-user, legacy, or public read occurs
    expect(calls).toEqual([
      { method: 'from', args: ['positions'] },
      {
        method: 'select',
        args: [
          'market_id,user_id,side,placed_at_ms,market:markets!inner(id,group_id),user:users!inner(display_name,username)',
        ],
      },
      { method: 'eq', args: ['market_id', MARKET_ID] },
      { method: 'eq', args: ['side', 'back'] },
      { method: 'neq', args: ['state', 'void'] },
      { method: 'order', args: ['placed_at_ms', { ascending: true }] },
      { method: 'order', args: ['user_id', { ascending: true }] },
      { method: 'order', args: ['side', { ascending: true }] },
      { method: 'limit', args: [5] },
      { method: 'from', args: ['positions'] },
      {
        method: 'select',
        args: [
          'market_id,user_id,side,placed_at_ms,market:markets!inner(id,group_id),user:users!inner(display_name,username)',
        ],
      },
      { method: 'eq', args: ['market_id', MARKET_ID] },
      { method: 'eq', args: ['side', 'doubt'] },
      { method: 'neq', args: ['state', 'void'] },
      { method: 'order', args: ['placed_at_ms', { ascending: true }] },
      { method: 'order', args: ['user_id', { ascending: true }] },
      { method: 'order', args: ['side', { ascending: true }] },
      { method: 'limit', args: [5] },
    ]);
    expect(participants).toEqual([
      {
        group_id: -100_123,
        market_id: MARKET_ID,
        user_id: 7002,
        side: 'doubt',
        display_name: 'Bob',
        username: null,
      },
      {
        group_id: -100_123,
        market_id: MARKET_ID,
        user_id: 7001,
        side: 'back',
        display_name: 'Alice',
        username: 'alice_calls',
      },
    ]);
  });

  it('rejects a participant side larger than its database limit', async () => {
    // Given a malicious back-side response with six rows despite limit five
    const oversizedBackRows = Array.from({ length: 6 }, (_, index) =>
      participantRow({
        user_id: 7001 + index,
        placed_at_ms: 1_720_000_000_001 + index,
      }),
    );
    const db = queryDbResponses([
      { data: oversizedBackRows, error: null },
      { data: [], error: null },
    ]);

    // When participant identities cross the facade boundary
    const result = db.positionParticipantsForMarket(MARKET_ID);

    // Then the facade distrusts the oversized PostgREST response
    await expect(result).rejects.toThrow('database contract violation at <rows>');
  });

  it('reserves five participant rows for each side', async () => {
    // Given both side partitions filled to their independent limits
    const backRows = Array.from({ length: 5 }, (_, index) =>
      participantRow({
        user_id: 7001 + index,
        placed_at_ms: 1_720_000_000_001 + index * 2,
      }),
    );
    const doubtRows = Array.from({ length: 5 }, (_, index) =>
      participantRow({
        user_id: 8001 + index,
        side: 'doubt',
        placed_at_ms: 1_720_000_000_002 + index * 2,
      }),
    );
    const db = queryDbResponses([
      { data: backRows, error: null },
      { data: doubtRows, error: null },
    ]);

    // When the bounded card projection is loaded
    const participants = await db.positionParticipantsForMarket(MARKET_ID);

    // Then neither side consumes the other's quota and total rows stay bounded
    expect(participants).toHaveLength(10);
    expect(participants.filter((participant) => participant.side === 'back')).toHaveLength(5);
    expect(participants.filter((participant) => participant.side === 'doubt')).toHaveLength(5);
  });

  it('rejects rows that make one market appear in multiple groups', async () => {
    // Given a cross-group-looking response for one requested market
    const db = queryDbResponses([
      { data: [participantRow({ placed_at_ms: 1 })], error: null },
      {
        data: [
          participantRow({
            user_id: 7002,
            side: 'doubt',
            placed_at_ms: 2,
            market: { id: MARKET_ID, group_id: -100_999 },
            user: { display_name: 'Mallory', username: null },
          }),
        ],
        error: null,
      },
    ]);

    // When participants are parsed
    const result = db.positionParticipantsForMarket(MARKET_ID);

    // Then the facade fails closed at the group boundary
    await expect(result).rejects.toThrow('database contract violation at group_id');
  });

  it('rejects rows that violate first-placement order', async () => {
    // Given rows returned with descending placement timestamps
    const db = queryDbResponses([
      {
        data: [
          participantRow({ placed_at_ms: 2 }),
          participantRow({ user_id: 7002, placed_at_ms: 1 }),
        ],
        error: null,
      },
      { data: [], error: null },
    ]);

    // When participants are parsed
    const result = db.positionParticipantsForMarket(MARKET_ID);

    // Then stale ordering is rejected rather than normalized locally
    await expect(result).rejects.toThrow('database contract violation at <order>');
  });
});
