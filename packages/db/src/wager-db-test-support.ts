import type { PgResult } from './errors.js';
import {
  wagerDbFromClient,
  type WagerDbClient,
  type WagerFilterBuilder,
  type WagerTableBuilder,
} from './wager-db.js';
import type { WagerLedgerEntry } from './wager-types.js';

export type Row = Record<string, unknown>;

type Filter =
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'in'; column: string; values: readonly unknown[] }
  | { kind: 'is'; column: string };

interface TableSpec {
  uniques?: string[][];
  serialColumn?: string;
  defaults?: Row;
}

class FakeTable {
  rows: Row[] = [];
  nextSerial = 1;
  constructor(readonly spec: TableSpec) {}
}

type PendingOp =
  | { kind: 'select' }
  | { kind: 'upsert'; value: Row; onConflict: string[]; ignoreDuplicates: boolean }
  | { kind: 'update'; patch: Row }
  | { kind: 'delete' };

function rowFromObject(values: object): Row {
  const row: Row = {};
  for (const key of Object.keys(values)) {
    row[key] = Reflect.get(values, key);
  }
  return row;
}

class FakeQuery implements WagerFilterBuilder, WagerTableBuilder {
  private readonly filters: Filter[] = [];
  private columns: string | undefined;
  private op: PendingOp = { kind: 'select' };

  constructor(private readonly table: FakeTable) {}

  select(columns?: string): WagerFilterBuilder {
    this.columns = columns ?? '*';
    return this;
  }

  upsert(values: object, options?: { onConflict?: string; ignoreDuplicates?: boolean }): WagerFilterBuilder {
    this.op = {
      kind: 'upsert',
      value: rowFromObject(values),
      onConflict: (options?.onConflict ?? '')
        .split(',')
        .map((column) => column.trim())
        .filter(Boolean),
      ignoreDuplicates: options?.ignoreDuplicates ?? false,
    };
    return this;
  }

  update(values: object): WagerFilterBuilder {
    this.op = { kind: 'update', patch: rowFromObject(values) };
    return this;
  }

  delete(): WagerFilterBuilder {
    this.op = { kind: 'delete' };
    return this;
  }

  eq(column: string, value: unknown): WagerFilterBuilder {
    this.filters.push({ kind: 'eq', column, value });
    return this;
  }

  in(column: string, values: readonly unknown[]): WagerFilterBuilder {
    this.filters.push({ kind: 'in', column, values });
    return this;
  }

  is(column: string, _value: null): WagerFilterBuilder {
    this.filters.push({ kind: 'is', column });
    return this;
  }

  maybeSingle(): Promise<PgResult<unknown>> {
    const result = this.execute();
    if (result.error) return Promise.resolve({ data: null, error: result.error });
    const rows = result.data ?? [];
    if (rows.length > 1) {
      return Promise.resolve({ data: null, error: { message: 'more than one row returned' } });
    }
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  then<TResult1 = PgResult<unknown>, TResult2 = never>(
    onfulfilled?: ((value: PgResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => {
      if (filter.kind === 'eq') return row[filter.column] === filter.value;
      if (filter.kind === 'in') return filter.values.includes(row[filter.column]);
      // A column never written is SQL null (tables default these to null).
      return (row[filter.column] ?? null) === null;
    });
  }

  private project(rows: Row[]): Row[] {
    if (this.columns === undefined || this.columns === '*') return rows.map((row) => ({ ...row }));
    const wanted = this.columns.split(',').map((column) => column.trim());
    return rows.map((row) => Object.fromEntries(wanted.map((column) => [column, row[column]])));
  }

  private uniqueViolation(candidate: Row, exclude?: Row): { message: string; code: string } | null {
    for (const columns of this.table.spec.uniques ?? []) {
      if (columns.some((column) => candidate[column] === undefined || candidate[column] === null)) {
        continue;
      }
      const clash = this.table.rows.find(
        (row) => row !== exclude && columns.every((column) => row[column] === candidate[column]),
      );
      if (clash) {
        return { message: `duplicate key value (${columns.join(',')})`, code: '23505' };
      }
    }
    return null;
  }

  private execute(): PgResult<Row[]> {
    const op = this.op;
    switch (op.kind) {
      case 'select':
        return { data: this.project(this.table.rows.filter((row) => this.matches(row))), error: null };
      case 'upsert': {
        const match =
          op.onConflict.length > 0
            ? this.table.rows.find((row) => op.onConflict.every((col) => row[col] === op.value[col]))
            : undefined;
        if (match) {
          if (op.ignoreDuplicates) return { data: [], error: null };
          const clash = this.uniqueViolation(op.value, match);
          if (clash) return { data: null, error: clash };
          Object.assign(match, op.value);
          return { data: this.project([match]), error: null };
        }
        const clash = this.uniqueViolation(op.value);
        if (clash) return { data: null, error: clash };
        const inserted: Row = { ...this.table.spec.defaults, ...op.value };
        const serial = this.table.spec.serialColumn;
        if (serial && inserted[serial] === undefined) inserted[serial] = this.table.nextSerial++;
        this.table.rows.push(inserted);
        return { data: this.project([inserted]), error: null };
      }
      case 'update': {
        const targets = this.table.rows.filter((row) => this.matches(row));
        for (const row of targets) Object.assign(row, op.patch);
        return { data: this.project(targets), error: null };
      }
      case 'delete': {
        const removed = this.table.rows.filter((row) => this.matches(row));
        this.table.rows = this.table.rows.filter((row) => !removed.includes(row));
        return { data: this.project(removed), error: null };
      }
    }
  }
}

export class FakeSupabase implements WagerDbClient {
  readonly rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  private readonly tables = new Map<string, FakeTable>();
  private readonly rpcHandlers = new Map<string, (args: Record<string, unknown>) => PgResult<unknown>>();

  constructor() {
    this.define('markets', { uniques: [['id']] });
    this.define('settlements', { uniques: [['market_id']] });
    this.define('wager_groups', { uniques: [['group_id']] });
    this.define('wager_wallet_links', {
      uniques: [['user_id'], ['pubkey']],
      defaults: { last_wager_group_id: null, created_at: NOW_ISO },
    });
    this.define('wager_ledger_entries', {
      uniques: [['idempotency_key']],
      serialColumn: 'id',
      defaults: { asset: 'sol' },
    });
    this.define('wager_deposits', {
      uniques: [['tx_sig', 'ix_index']],
      serialColumn: 'id',
      defaults: {
        asset: 'sol',
        mint_pubkey: null,
        user_id: null,
        credited_at: null,
        observed_at: NOW_ISO,
      },
    });
    this.define('wager_withdrawals', { uniques: [['id']], defaults: { asset: 'sol' } });
    this.define('wager_settlements_applied', { uniques: [['market_id']] });
    this.define('wager_status', { uniques: [['id']] });
    this.define('wager_asset_status', { uniques: [['asset']] });
  }

  from(table: string): WagerTableBuilder {
    return new FakeQuery(this.require(table));
  }

  rpc(fn: string, args: Record<string, unknown>): Promise<PgResult<unknown>> {
    this.rpcCalls.push({ fn, args });
    const handler = this.rpcHandlers.get(fn);
    if (!handler) return Promise.resolve({ data: null, error: { message: `no rpc handler: ${fn}` } });
    return Promise.resolve(handler(args));
  }

  onRpc(fn: string, handler: (args: Record<string, unknown>) => PgResult<unknown>): void {
    this.rpcHandlers.set(fn, handler);
  }

  seed(table: string, rows: Row[]): void {
    const target = this.require(table);
    target.rows.push(...rows.map((row) => ({ ...target.spec.defaults, ...row })));
  }

  rows(table: string): Row[] {
    return this.require(table).rows;
  }

  private define(name: string, spec: TableSpec): void {
    this.tables.set(name, new FakeTable(spec));
  }

  private require(name: string): FakeTable {
    const table = this.tables.get(name);
    if (!table) throw new Error(`fake has no table ${name}`);
    return table;
  }
}

export function makeHarness() {
  const fake = new FakeSupabase();
  return { fake, db: wagerDbFromClient(fake) };
}

export const USER_ID = 7001;
export const OTHER_USER_ID = 7002;
export const GROUP_ID = -100123;
export const MARKET_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
export const NOW_ISO = '2026-07-04T12:00:00.000Z';
export const UNSAFE_INTEGER = 2 ** 53;
export const UNSAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

export function ledgerEntry(overrides: Partial<WagerLedgerEntry> = {}): WagerLedgerEntry {
  return {
    user_id: USER_ID,
    group_id: null,
    market_id: null,
    kind: 'deposit',
    lamports: 10_000_000n,
    idempotency_key: 'wager:deposit:sig1:0',
    ...overrides,
  };
}

export function withdrawalRow(overrides: Row = {}): Row {
  return {
    id: 'w-1',
    user_id: USER_ID,
    dest_pubkey: 'DestPubkey1111111111111111111111111111111111',
    asset: 'sol',
    lamports: 10_000_000,
    state: 'debited',
    tx_sig: null,
    raw_tx_b64: null,
    last_valid_block_height: null,
    error: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}
