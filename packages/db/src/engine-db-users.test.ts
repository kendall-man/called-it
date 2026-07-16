import { describe, expect, it, vi } from 'vitest';
import { createEngineDb } from './engine-db.js';

const queryState = vi.hoisted<{
  readonly calls: Array<{
    readonly table: string;
    readonly columns: string;
    readonly filterColumn: string;
    readonly values: readonly unknown[];
  }>;
}>(() => ({ calls: [] }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      return {
        select(columns: string) {
          return {
            async in(filterColumn: string, values: readonly unknown[]) {
              queryState.calls.push({ table, columns, filterColumn, values });
              return {
                data: [
                  { id: 2, display_name: 'Bob' },
                  { id: 1, display_name: 'Alice' },
                ],
                error: null,
              };
            },
          };
        },
      };
    },
    async rpc() {
      throw new TypeError('RPC was not expected');
    },
  }),
}));

describe('EngineDb user-name projection', () => {
  it('deduplicates requested ids into one bulk users query', async () => {
    // Given duplicate winner ids at the engine database boundary
    queryState.calls.length = 0;
    const db = createEngineDb('https://db.invalid', 'service-role-key');

    // When payout rendering requests their display names
    const names = await db.getUserNames([3, 1, 3, 2, 1]);

    // Then one deduplicated query returns only persisted display names
    expect(queryState.calls).toEqual([{
      table: 'users',
      columns: 'id,display_name',
      filterColumn: 'id',
      values: [3, 1, 2],
    }]);
    expect(names).toEqual(new Map([
      [2, 'Bob'],
      [1, 'Alice'],
    ]));
  });
});
