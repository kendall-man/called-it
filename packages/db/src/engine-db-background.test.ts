import { describe, expect, it, vi } from 'vitest';
import { createEngineDb } from './engine-db.js';

type QueryCall = {
  readonly method: string;
  readonly args: readonly unknown[];
};

const queryState = vi.hoisted<{ readonly calls: QueryCall[] }>(() => ({ calls: [] }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    const query = {
      in(column: string, values: readonly unknown[]) {
        queryState.calls.push({ method: 'in', args: [column, values] });
        return query;
      },
      lte(column: string, value: string) {
        queryState.calls.push({ method: 'lte', args: [column, value] });
        return query;
      },
      async select() {
        queryState.calls.push({ method: 'select', args: [] });
        return { data: [], error: null };
      },
    };
    return {
      from(table: string) {
        queryState.calls.push({ method: 'from', args: [table] });
        return {
          update(patch: unknown) {
            queryState.calls.push({ method: 'update', args: [patch] });
            return query;
          },
        };
      },
      async rpc() {
        throw new TypeError('RPC was not expected');
      },
    };
  },
}));

describe('EngineDb background filters', () => {
  it('adds allowed group ids to the overdue-claim update query', async () => {
    // Given a service-role database and an exact deployed group allowlist
    queryState.calls.length = 0;
    const db = createEngineDb('https://db.invalid', 'service-role-key');
    const nowIso = '2026-07-12T12:00:00.000Z';

    // When overdue claims are expired for background work
    await db.expireOverdueClaims(nowIso, [-100_910_001]);

    // Then PostgREST scopes the update before it is executed
    expect(queryState.calls).toEqual([
      { method: 'from', args: ['claims'] },
      { method: 'update', args: [{ status: 'expired' }] },
      {
        method: 'in',
        args: ['status', ['detected', 'nudged', 'clarifying', 'awaiting_confirm']],
      },
      { method: 'lte', args: ['expires_at', nowIso] },
      { method: 'in', args: ['group_id', [-100_910_001]] },
      { method: 'select', args: [] },
    ]);
  });
});
