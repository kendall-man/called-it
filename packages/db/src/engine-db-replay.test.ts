import { describe, expect, it, vi } from 'vitest';
import { createEngineDb } from './engine-db.js';

const rpcState = vi.hoisted<{
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}>(() => ({ calls: [] }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from() {
      throw new TypeError('table query was not expected');
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcState.calls.push({ name, args });
      return {
        async single() {
          return {
            data: {
              ok: true,
              duplicate: false,
              position_id: '00000000-0000-4000-8000-000000000701',
            },
            error: null,
          };
        },
      };
    },
  }),
}));

describe('EngineDb replay position boundary', () => {
  it('routes the fixed test choice through the atomic service-role RPC', async () => {
    rpcState.calls.length = 0;
    const db = createEngineDb('https://db.invalid', 'service-role-key');

    const result = await db.placeReplayPosition({
      user_id: 700,
      group_id: -100_777,
      market_id: '00000000-0000-4000-8000-000000000601',
      side: 'back',
      stake: 10_000_000,
      locked_multiplier: 1.6,
      locked_odds_message_id: 'odds-1',
      locked_odds_ts: 123,
      state: 'active',
      placed_at_ms: 456,
    });

    expect(result).toEqual({
      ok: true,
      duplicate: false,
      position_id: '00000000-0000-4000-8000-000000000701',
    });
    expect(rpcState.calls).toEqual([{
      name: 'place_replay_position',
      args: {
        p_user_id: 700,
        p_group_id: -100_777,
        p_market_id: '00000000-0000-4000-8000-000000000601',
        p_side: 'back',
        p_stake: 10_000_000,
        p_multiplier: 1.6,
        p_state: 'active',
        p_placed_at_ms: 456,
      },
    }]);
  });
});
