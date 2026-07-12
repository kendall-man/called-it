import type { PgResult } from './errors.js';
import { groupPointsDbFromClient, type GroupPointsDb } from './group-points.js';

export const MARKET_ID = 'a3bb189e-8bf9-4888-9912-ace4e6543002';

export type QueryCall = {
  readonly method: string;
  readonly args: readonly unknown[];
};

export type RpcCall = {
  readonly fn: string;
  readonly args: Readonly<Record<string, unknown>>;
};

class ScriptedQuery implements PromiseLike<PgResult<unknown>> {
  constructor(
    private readonly response: PgResult<unknown>,
    private readonly calls: QueryCall[],
  ) {}

  select(columns: string): ScriptedQuery {
    this.calls.push({ method: 'select', args: [columns] });
    return this;
  }

  eq(column: string, value: unknown): ScriptedQuery {
    this.calls.push({ method: 'eq', args: [column, value] });
    return this;
  }

  neq(column: string, value: unknown): ScriptedQuery {
    this.calls.push({ method: 'neq', args: [column, value] });
    return this;
  }

  order(column: string, options: { readonly ascending: boolean }): ScriptedQuery {
    this.calls.push({ method: 'order', args: [column, options] });
    return this;
  }

  limit(value: number): ScriptedQuery {
    this.calls.push({ method: 'limit', args: [value] });
    return this;
  }

  maybeSingle(): Promise<PgResult<unknown>> {
    this.calls.push({ method: 'maybeSingle', args: [] });
    return Promise.resolve(this.response);
  }

  then<TResult1 = PgResult<unknown>, TResult2 = never>(
    onfulfilled?: ((value: PgResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.response).then(onfulfilled, onrejected);
  }
}

export function queryDb(response: PgResult<unknown>, calls: QueryCall[] = []): GroupPointsDb {
  return queryDbResponses([response], calls);
}

export function queryDbResponses(
  responses: readonly PgResult<unknown>[],
  calls: QueryCall[] = [],
): GroupPointsDb {
  let responseIndex = 0;
  return groupPointsDbFromClient({
    from(table: string) {
      calls.push({ method: 'from', args: [table] });
      const response = responses[responseIndex];
      if (response === undefined) throw new TypeError('unexpected table query');
      responseIndex += 1;
      return new ScriptedQuery(response, calls);
    },
    async rpc() {
      throw new TypeError('RPC was not expected');
    },
  });
}

export function rpcDb(response: PgResult<unknown>, calls: RpcCall[] = []): GroupPointsDb {
  return groupPointsDbFromClient({
    from() {
      throw new TypeError('table query was not expected');
    },
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(response);
    },
  });
}

export async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new TypeError('expected promise to reject');
}
