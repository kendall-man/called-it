import { describe, expect, it, vi } from 'vitest';
import { createEngineDb } from './engine-db.js';
import { captureRejection, MARKET_ID, rpcDb } from './group-points-test-support.js';

const rpcState = vi.hoisted<{
  readonly calls: Array<{ readonly fn: string; readonly args: Record<string, unknown> }>;
}>(() => ({ calls: [] }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from() {
      throw new TypeError('table query was not expected');
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcState.calls.push({ fn, args });
      return {
        data: {
          ok: true,
          eligible: true,
          duplicate: false,
          reason: null,
          group_id: -100_123,
          scored_count: 2,
          winner_count: 1,
        },
        error: null,
      };
    },
  }),
}));

describe('group points RPC facade', () => {
  it('applies points with the exact database-owned RPC contract', async () => {
    // Given a valid atomic scoring response from the database
    rpcState.calls.length = 0;
    const db = createEngineDb('https://db.invalid', 'service-role-key');

    // When the engine applies points for one market
    const result = await db.applyGroupPoints(MARKET_ID);

    // Then only the market id is forwarded and the strict result is preserved
    expect(rpcState.calls).toEqual([
      { fn: 'group_points_apply', args: { p_market_id: MARKET_ID } },
    ]);
    expect(result).toEqual({
      ok: true,
      eligible: true,
      duplicate: false,
      reason: null,
      group_id: -100_123,
      scored_count: 2,
      winner_count: 1,
    });
  });

  it('rejects malformed and unsafe scoring payloads without echoing their contents', async () => {
    // Given payloads spanning shape, numeric, and state invariants
    const rawSentinel = 'RAW_RPC_VALUE_MUST_NOT_LEAK';
    const payloads: readonly unknown[] = [
      [rawSentinel],
      {
        ok: true,
        eligible: true,
        duplicate: false,
        reason: null,
        group_id: Number.MAX_SAFE_INTEGER + 1,
        scored_count: 1,
        winner_count: 1,
      },
      {
        ok: true,
        eligible: true,
        duplicate: false,
        reason: null,
        group_id: -100_123,
        scored_count: -1,
        winner_count: 0,
      },
      {
        ok: true,
        eligible: true,
        duplicate: false,
        reason: null,
        group_id: -100_123,
        scored_count: 1,
        winner_count: 2,
      },
      {
        ok: true,
        eligible: false,
        duplicate: true,
        reason: 'replay',
        group_id: -100_123,
        scored_count: 0,
        winner_count: 0,
      },
    ];

    // When each payload crosses the facade boundary
    for (const payload of payloads) {
      const error = await captureRejection(
        rpcDb({ data: payload, error: null }).applyGroupPoints(MARKET_ID),
      );

      // Then it fails closed with a redacted database-contract error
      expect(error.message).toContain('database contract violation');
      expect(error.message).not.toContain(rawSentinel);
      expect(error.message).not.toContain(String(Number.MAX_SAFE_INTEGER + 1));
    }
  });
});
