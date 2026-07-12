import { describe, expect, it } from 'vitest';
import {
  MARKET_ID,
  rpcDb,
  type RpcCall,
} from './group-points-test-support.js';

const projectedParticipantRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  group_id: -100_123,
  market_id: MARKET_ID,
  user_id: 7001,
  side: 'back',
  first_placed_at_ms: 1_720_000_000_001,
  display_name: 'Alice',
  username: 'alice_calls',
  participant_count: 1,
  ...overrides,
});

describe('group point participant queries', () => {
  it('uses one bounded participant RPC with authoritative distinct side totals', async () => {
    // Given a flat, globally ordered projection with independent side totals.
    const calls: RpcCall[] = [];
    const db = rpcDb(
      {
        data: [
          projectedParticipantRow(),
          projectedParticipantRow({
            user_id: 8001,
            side: 'doubt',
            first_placed_at_ms: 1_720_000_000_002,
            display_name: 'Bob',
            username: null,
            participant_count: 1,
          }),
        ],
        error: null,
      },
      calls,
    );

    // When participants are loaded for one market.
    const participants = await db.positionParticipantsForMarket(MARKET_ID);

    // Then one private RPC supplies minimal identity rows and exact distinct totals.
    expect(calls).toEqual([
      { fn: 'group_market_participants', args: { p_market_id: MARKET_ID } },
    ]);
    expect(participants).toEqual([
      {
        group_id: -100_123,
        market_id: MARKET_ID,
        user_id: 7001,
        side: 'back',
        display_name: 'Alice',
        username: 'alice_calls',
        participant_count: 1,
      },
      {
        group_id: -100_123,
        market_id: MARKET_ID,
        user_id: 8001,
        side: 'doubt',
        display_name: 'Bob',
        username: null,
        participant_count: 1,
      },
    ]);
  });

  it('reserves five rows per side while preserving totals beyond each visible prefix', async () => {
    // Given both side prefixes filled and globally interleaved by first placement.
    const rows = Array.from({ length: 5 }, (_, index) => [
      projectedParticipantRow({
        user_id: 7001 + index,
        first_placed_at_ms: 1_720_000_000_001 + index * 2,
        participant_count: 7,
      }),
      projectedParticipantRow({
        user_id: 8001 + index,
        side: 'doubt',
        first_placed_at_ms: 1_720_000_000_002 + index * 2,
        participant_count: 6,
      }),
    ]).flat();
    const db = rpcDb({ data: rows, error: null });

    // When the bounded projection crosses the facade.
    const participants = await db.positionParticipantsForMarket(MARKET_ID);

    // Then neither side consumes the other quota and both authoritative totals survive.
    const back = participants.filter((participant) => participant.side === 'back');
    const doubt = participants.filter((participant) => participant.side === 'doubt');
    expect(back).toHaveLength(5);
    expect(doubt).toHaveLength(5);
    expect(back.every((participant) => participant.participant_count === 7)).toBe(true);
    expect(doubt.every((participant) => participant.participant_count === 6)).toBe(true);
  });

  it('rejects more than five returned identities on one side', async () => {
    // Given six distinct back-side rows inside the ten-row overall transport bound.
    const rows = Array.from({ length: 6 }, (_, index) =>
      projectedParticipantRow({
        user_id: 7001 + index,
        first_placed_at_ms: 1_720_000_000_001 + index,
        participant_count: 6,
      }),
    );

    // When the malformed side projection crosses the facade.
    const result = rpcDb({ data: rows, error: null }).positionParticipantsForMarket(MARKET_ID);

    // Then the facade rejects the per-side limit violation.
    await expect(result).rejects.toThrow('database contract violation at <rows>');
  });

  it('rejects duplicate market-user-side rows instead of hiding an RPC defect', async () => {
    // Given the same participant key returned twice with a distinct total of one.
    const repeated = projectedParticipantRow();
    const db = rpcDb({ data: [repeated, repeated], error: null });

    // When the duplicate projection is parsed.
    const result = db.positionParticipantsForMarket(MARKET_ID);

    // Then SQL deduplication remains an enforced boundary contract.
    await expect(result).rejects.toThrow('database contract violation at user_id');
  });

  it('rejects a participant row with no authoritative count', async () => {
    // Given an RPC row with participant_count omitted.
    const row = projectedParticipantRow();
    Reflect.deleteProperty(row, 'participant_count');
    const db = rpcDb({ data: [row], error: null });

    // When the incomplete projection crosses the facade.
    const result = db.positionParticipantsForMarket(MARKET_ID);

    // Then the response fails closed before reaching the engine row contract.
    await expect(result).rejects.toThrow('database contract violation at <keys>');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'rejects unsafe participant_count value %s',
    async (participantCount) => {
      // Given a participant count that is not a safe non-negative integer.
      const db = rpcDb({
        data: [projectedParticipantRow({ participant_count: participantCount })],
        error: null,
      });

      // When the unsafe count crosses the facade.
      const result = db.positionParticipantsForMarket(MARKET_ID);

      // Then the parser rejects the field instead of normalizing it.
      await expect(result).rejects.toThrow(
        'database contract violation at participant_count',
      );
    },
  );

  it.each([
    ['zero', [projectedParticipantRow({ participant_count: 0 })]],
    [
      'higher than an incomplete prefix',
      [projectedParticipantRow({ participant_count: 2 })],
    ],
    [
      'inconsistent within one side',
      [
        projectedParticipantRow({ participant_count: 2 }),
        projectedParticipantRow({
          user_id: 7002,
          first_placed_at_ms: 1_720_000_000_002,
          participant_count: 3,
        }),
      ],
    ],
    [
      'lower than returned distinct rows',
      [
        projectedParticipantRow(),
        projectedParticipantRow({
          user_id: 7002,
          first_placed_at_ms: 1_720_000_000_002,
        }),
      ],
    ],
  ])('rejects a %s participant total', async (_case, rows) => {
    // Given a non-authoritative side total.
    const db = rpcDb({ data: rows, error: null });

    // When the total crosses the facade.
    const result = db.positionParticipantsForMarket(MARKET_ID);

    // Then the response fails closed at the participant-count contract.
    await expect(result).rejects.toThrow('database contract violation at participant_count');
  });

  it('rejects rows that make one market appear in multiple groups', async () => {
    // Given a cross-group-looking response for one requested market
    const db = rpcDb({
      data: [
        projectedParticipantRow({ first_placed_at_ms: 1 }),
        projectedParticipantRow({
          group_id: -100_999,
          user_id: 8001,
          side: 'doubt',
          first_placed_at_ms: 2,
          display_name: 'Mallory',
          participant_count: 1,
        }),
      ],
      error: null,
    });

    // When participants are parsed
    const result = db.positionParticipantsForMarket(MARKET_ID);

    // Then the facade fails closed at the group boundary
    await expect(result).rejects.toThrow('database contract violation at group_id');
  });

  it('rejects rows that violate first-placement order', async () => {
    // Given rows returned with descending placement timestamps
    const db = rpcDb({
      data: [
        projectedParticipantRow({ first_placed_at_ms: 2, participant_count: 2 }),
        projectedParticipantRow({
          user_id: 7002,
          first_placed_at_ms: 1,
          participant_count: 2,
        }),
      ],
      error: null,
    });

    // When participants are parsed
    const result = db.positionParticipantsForMarket(MARKET_ID);

    // Then stale ordering is rejected rather than normalized locally
    await expect(result).rejects.toThrow('database contract violation at <order>');
  });

  it('rejects unrestricted identity fields from the participant RPC', async () => {
    // Given an otherwise valid row carrying an unapproved private field.
    const db = rpcDb({
      data: [projectedParticipantRow({ wallet_pubkey: 'PRIVATE_VALUE' })],
      error: null,
    });

    // When the row crosses the minimal projection boundary.
    const result = db.positionParticipantsForMarket(MARKET_ID);

    // Then exact-key parsing prevents the extra source field from propagating.
    await expect(result).rejects.toThrow('database contract violation at <keys>');
  });
});
