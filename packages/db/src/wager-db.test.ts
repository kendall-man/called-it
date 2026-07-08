/**
 * Hermetic tests for the wager façade: no network, no live Postgres. The
 * façade runs against an in-memory WagerDbClient fake (same spirit as the
 * in-memory EngineDb fakes in apps/engine tests), and the pure quantization
 * math (mult_milli, floor payouts, worst-case liability) is tested directly —
 * it is the JS mirror of the SQL inside migrations/0002_wager.sql.
 */

import { describe, expect, it } from 'vitest';
import { DbError, type PgResult } from './errors.js';
import {
  assertSafeInteger,
  multMilli,
  stakePayoutLamports,
  WAGER_MULT_SCALE,
  wagerDbFromClient,
  type WagerDbClient,
  type WagerFilterBuilder,
  type WagerTableBuilder,
} from './wager-db.js';
import type { WagerLedgerEntry, WagerStakeInput } from './wager-types.js';

// ── In-memory supabase fake (structural WagerDbClient) ─────────────────────

type Row = Record<string, unknown>;

type Filter =
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'in'; column: string; values: readonly unknown[] }
  | { kind: 'is'; column: string };

interface TableSpec {
  uniques?: string[][];
  serialColumn?: string;
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
      value: values as Row,
      onConflict: (options?.onConflict ?? '')
        .split(',')
        .map((column) => column.trim())
        .filter(Boolean),
      ignoreDuplicates: options?.ignoreDuplicates ?? false,
    };
    return this;
  }

  update(values: object): WagerFilterBuilder {
    this.op = { kind: 'update', patch: values as Row };
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

  maybeSingle(): Promise<PgResult<Row | null>> {
    const result = this.execute();
    if (result.error) return Promise.resolve({ data: null, error: result.error });
    const rows = result.data ?? [];
    if (rows.length > 1) {
      return Promise.resolve({ data: null, error: { message: 'more than one row returned' } });
    }
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  then<TResult1 = PgResult<Row[]>, TResult2 = never>(
    onfulfilled?: ((value: PgResult<Row[]>) => TResult1 | PromiseLike<TResult1>) | null,
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
        const inserted: Row = { ...op.value };
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

class FakeSupabase implements WagerDbClient {
  readonly rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  private readonly tables = new Map<string, FakeTable>();
  private readonly rpcHandlers = new Map<string, (args: Record<string, unknown>) => PgResult<unknown>>();

  constructor() {
    this.define('markets', { uniques: [['id']] });
    this.define('settlements', { uniques: [['market_id']] });
    this.define('wager_groups', { uniques: [['group_id']] });
    this.define('wager_wallet_links', { uniques: [['user_id'], ['pubkey']] });
    this.define('wager_ledger_entries', { uniques: [['idempotency_key']], serialColumn: 'id' });
    this.define('wager_deposits', { uniques: [['tx_sig', 'ix_index']], serialColumn: 'id' });
    this.define('wager_withdrawals', { uniques: [['id']] });
    this.define('wager_settlements_applied', { uniques: [['market_id']] });
    this.define('wager_status', { uniques: [['id']] });
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
    this.require(table).rows.push(...rows);
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

function makeHarness() {
  const fake = new FakeSupabase();
  return { fake, db: wagerDbFromClient(fake) };
}

const USER_ID = 7001;
const OTHER_USER_ID = 7002;
const GROUP_ID = -100123;
const MARKET_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const NOW_ISO = '2026-07-04T12:00:00.000Z';
const UNSAFE_INTEGER = 2 ** 53;
const UNSAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

function ledgerEntry(overrides: Partial<WagerLedgerEntry> = {}): WagerLedgerEntry {
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

function withdrawalRow(overrides: Row = {}): Row {
  return {
    id: 'w-1',
    user_id: USER_ID,
    dest_pubkey: 'DestPubkey1111111111111111111111111111111111',
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

// ── Pure quantization math (JS mirror of the wager_stake SQL) ──────────────

describe('liability math', () => {
  it('uses the frozen MULT_SCALE of 1000', () => {
    expect(WAGER_MULT_SCALE).toBe(1000);
  });

  it('multMilli quantizes multipliers to milli-units', () => {
    expect(multMilli(1)).toBe(1000n);
    expect(multMilli(1.6)).toBe(1600n);
    expect(multMilli(2.147)).toBe(2147n);
    // Float edge: must agree with SQL round((m * 1000)::float8) — both sides
    // evaluate the product in IEEE float64 before rounding.
    expect(multMilli(1.0005)).toBe(BigInt(Math.round(1.0005 * 1000)));
  });

  it('multMilli rejects non-finite and negative multipliers', () => {
    expect(() => multMilli(Number.NaN)).toThrow(DbError);
    expect(() => multMilli(Number.POSITIVE_INFINITY)).toThrow(DbError);
    expect(() => multMilli(-1)).toThrow(DbError);
  });

  it('stakePayoutLamports floors like the SQL bigint division', () => {
    expect(stakePayoutLamports(3n, 1333n)).toBe(3n); // floor(3.999)
    expect(stakePayoutLamports(7n, 1500n)).toBe(10n); // floor(10.5)
    expect(stakePayoutLamports(10_000_000n, 1600n)).toBe(16_000_000n);
    expect(stakePayoutLamports(1n, 999n)).toBe(0n);
  });

});

describe('assertSafeInteger', () => {
  it('passes safe integers through, including negatives', () => {
    expect(assertSafeInteger('t', Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(assertSafeInteger('t', -Number.MAX_SAFE_INTEGER)).toBe(-Number.MAX_SAFE_INTEGER);
    expect(assertSafeInteger('t', 0)).toBe(0);
  });

  it('throws DbError on precision-lossy or fractional values', () => {
    expect(() => assertSafeInteger('t', UNSAFE_INTEGER)).toThrow(DbError);
    expect(() => assertSafeInteger('t', 1.5)).toThrow(DbError);
    expect(() => assertSafeInteger('t', Number.NaN)).toThrow(DbError);
  });
});

// ── Façade behavior against the in-memory client ───────────────────────────

describe('group opt-in', () => {
  it('defaults to disabled and round-trips the toggle', async () => {
    const { db, fake } = makeHarness();
    expect(await db.isGroupEnabled(GROUP_ID)).toBe(false);
    await db.setGroupEnabled(GROUP_ID, true, USER_ID);
    expect(await db.isGroupEnabled(GROUP_ID)).toBe(true);
    await db.setGroupEnabled(GROUP_ID, false, OTHER_USER_ID);
    expect(await db.isGroupEnabled(GROUP_ID)).toBe(false);
    // Upsert on group_id: one row, last toggler recorded.
    expect(fake.rows('wager_groups')).toHaveLength(1);
    expect(fake.rows('wager_groups')[0]?.enabled_by).toBe(OTHER_USER_ID);
  });
});

describe('wallet links', () => {
  const PUBKEY_A = 'PubkeyAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const PUBKEY_B = 'PubkeyBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  it('links, re-links (same user), and enforces first-link-wins on pubkeys', async () => {
    const { db, fake } = makeHarness();
    expect(await db.linkWallet({ user_id: USER_ID, pubkey: PUBKEY_A })).toEqual({
      ok: true,
      relinked: false,
    });
    // Another user claiming the same pubkey loses: first-link-wins.
    expect(await db.linkWallet({ user_id: OTHER_USER_ID, pubkey: PUBKEY_A })).toEqual({
      ok: false,
      reason: 'pubkey_taken',
    });
    // Same pubkey again is idempotent, not a re-link.
    expect(await db.linkWallet({ user_id: USER_ID, pubkey: PUBKEY_A })).toEqual({
      ok: true,
      relinked: false,
    });
    // The original owner can move to a new pubkey (future attribution moves).
    expect(await db.linkWallet({ user_id: USER_ID, pubkey: PUBKEY_B })).toEqual({
      ok: true,
      relinked: true,
    });
    expect(fake.rows('wager_wallet_links')).toHaveLength(1);
    expect((await db.getWalletLink(USER_ID))?.pubkey).toBe(PUBKEY_B);
    expect(await db.getWalletLinkByPubkey(PUBKEY_A)).toBeNull();
    expect((await db.getWalletLinkByPubkey(PUBKEY_B))?.user_id).toBe(USER_ID);
  });

  it('keeps the first verified_at timestamp and supports unlink', async () => {
    const { db, fake } = makeHarness();
    await db.linkWallet({ user_id: USER_ID, pubkey: PUBKEY_A, last_wager_group_id: GROUP_ID });
    expect(fake.rows('wager_wallet_links')[0]?.last_wager_group_id).toBe(GROUP_ID);
    await db.markWalletVerified(USER_ID);
    const first = fake.rows('wager_wallet_links')[0]?.verified_at;
    expect(typeof first).toBe('string');
    // Second verification must not move the timestamp (guarded by .is null).
    await db.markWalletVerified(USER_ID);
    expect(fake.rows('wager_wallet_links')[0]?.verified_at).toBe(first);

    await db.setLastWagerGroup(USER_ID, GROUP_ID + 1);
    expect(fake.rows('wager_wallet_links')[0]?.last_wager_group_id).toBe(GROUP_ID + 1);

    await db.unlinkWallet(USER_ID);
    expect(await db.getWalletLink(USER_ID)).toBeNull();
  });
});

describe('wager ledger', () => {
  it('postWagerLedger dedupes on idempotency_key', async () => {
    const { db, fake } = makeHarness();
    expect(await db.postWagerLedger(ledgerEntry())).toEqual({ inserted: true });
    expect(await db.postWagerLedger(ledgerEntry({ lamports: 999n }))).toEqual({ inserted: false });
    expect(fake.rows('wager_ledger_entries')).toHaveLength(1);
    // The first write wins entirely — the duplicate's payload is discarded.
    expect(fake.rows('wager_ledger_entries')[0]?.lamports).toBe(10_000_000);
  });

  it('rejects lamports beyond the Number-safe range before writing', async () => {
    const { db, fake } = makeHarness();
    await expect(db.postWagerLedger(ledgerEntry({ lamports: UNSAFE_BIGINT }))).rejects.toThrow(DbError);
    await expect(db.postWagerLedger(ledgerEntry({ lamports: -UNSAFE_BIGINT }))).rejects.toThrow(DbError);
    expect(fake.rows('wager_ledger_entries')).toHaveLength(0);
  });

  it('balances are user-global bigint sums; other users are excluded', async () => {
    const { db } = makeHarness();
    await db.postWagerLedger(ledgerEntry({ lamports: 5n, idempotency_key: 'k1' }));
    await db.postWagerLedger(ledgerEntry({ lamports: -2n, idempotency_key: 'k2', kind: 'stake' }));
    await db.postWagerLedger(
      ledgerEntry({ lamports: 100n, idempotency_key: 'k3', user_id: OTHER_USER_ID }),
    );
    expect(await db.balanceLamports(USER_ID)).toBe(3n);
    expect(await db.totalLedgerLamports()).toBe(103n);
  });

  it('sums exceeding 2^53 stay exact in bigint; corrupt rows fail loud', async () => {
    const { db, fake } = makeHarness();
    // Each row is individually safe; the bigint total exceeds 2^53 and must
    // still come back exact (a number-typed sum would silently round).
    fake.seed('wager_ledger_entries', [
      { id: 1, user_id: USER_ID, lamports: Number.MAX_SAFE_INTEGER, idempotency_key: 'a' },
      { id: 2, user_id: USER_ID, lamports: Number.MAX_SAFE_INTEGER, idempotency_key: 'b' },
    ]);
    expect(await db.balanceLamports(USER_ID)).toBe(2n * BigInt(Number.MAX_SAFE_INTEGER));

    const corrupt = makeHarness();
    corrupt.fake.seed('wager_ledger_entries', [
      { id: 1, user_id: USER_ID, lamports: UNSAFE_INTEGER, idempotency_key: 'bad' },
    ]);
    await expect(corrupt.db.balanceLamports(USER_ID)).rejects.toThrow(DbError);
  });
});

describe('deposits', () => {
  const deposit = {
    tx_sig: 'sig1',
    ix_index: 0,
    sender_pubkey: 'SenderPubkey11111111111111111111111111111111',
    lamports: 10_000_000n,
    slot: 250,
  };

  it('upsertDeposit is idempotent on (tx_sig, ix_index)', async () => {
    const { db, fake } = makeHarness();
    expect(await db.upsertDeposit(deposit)).toEqual({ inserted: true });
    // Same instruction re-observed → ignored.
    expect(await db.upsertDeposit(deposit)).toEqual({ inserted: false });
    // Second transfer in the SAME transaction (distinct ix_index) → new row.
    expect(await db.upsertDeposit({ ...deposit, ix_index: 1 })).toEqual({ inserted: true });
    expect(fake.rows('wager_deposits')).toHaveLength(2);
    expect(fake.rows('wager_deposits')[0]?.lamports).toBe(10_000_000);
  });

  it('rejects unsafe lamports before writing', async () => {
    const { db, fake } = makeHarness();
    await expect(db.upsertDeposit({ ...deposit, lamports: UNSAFE_BIGINT })).rejects.toThrow(DbError);
    expect(fake.rows('wager_deposits')).toHaveLength(0);
  });

  it('markDepositCredited attributes exactly once', async () => {
    const { db, fake } = makeHarness();
    await db.upsertDeposit(deposit);
    await db.markDepositCredited('sig1', 0, USER_ID);
    expect(fake.rows('wager_deposits')[0]).toMatchObject({ user_id: USER_ID });
    expect(fake.rows('wager_deposits')[0]?.credited_at).toBeTruthy();
    // Already credited → no-op, attribution never moves.
    await db.markDepositCredited('sig1', 0, OTHER_USER_ID);
    expect(fake.rows('wager_deposits')[0]?.user_id).toBe(USER_ID);
    expect(await db.orphanDepositsBySender(deposit.sender_pubkey)).toHaveLength(0);
  });

  it('orphanDepositsBySender returns only uncredited rows, lamports as bigint', async () => {
    const { db } = makeHarness();
    await db.upsertDeposit(deposit);
    await db.upsertDeposit({ ...deposit, tx_sig: 'sig2' });
    await db.markDepositCredited('sig2', 0, USER_ID);
    await db.upsertDeposit({ ...deposit, tx_sig: 'sig3', sender_pubkey: 'OtherSender' });
    const orphans = await db.orphanDepositsBySender(deposit.sender_pubkey);
    expect(orphans.map((row) => row.tx_sig)).toEqual(['sig1']);
    expect(orphans[0]?.lamports).toBe(10_000_000n);
  });
});

describe('withdrawal outbox transitions', () => {
  const SIGNED = {
    tx_sig: 'txsig-1',
    raw_tx_b64: 'AAAA',
    last_valid_block_height: 12345,
  };

  it('walks the happy path debited → submitted → confirmed', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_withdrawals', [withdrawalRow()]);
    await db.markWithdrawalSubmitted('w-1', SIGNED);
    expect(fake.rows('wager_withdrawals')[0]).toMatchObject({ state: 'submitted', ...SIGNED });
    await db.markWithdrawalConfirmed('w-1');
    expect(fake.rows('wager_withdrawals')[0]?.state).toBe('confirmed');
  });

  it('supports re-sign after expiry: submitted → submitted with fresh tx facts', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_withdrawals', [withdrawalRow({ state: 'submitted', ...SIGNED })]);
    const fresh = { tx_sig: 'txsig-2', raw_tx_b64: 'BBBB', last_valid_block_height: 23456 };
    await db.markWithdrawalSubmitted('w-1', fresh);
    expect(fake.rows('wager_withdrawals')[0]).toMatchObject({ state: 'submitted', ...fresh });
  });

  it('refuses illegal transitions (terminal states are immutable)', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_withdrawals', [withdrawalRow()]);
    // confirmed straight from 'debited' is a bug — nothing was broadcast.
    await db.markWithdrawalConfirmed('w-1');
    expect(fake.rows('wager_withdrawals')[0]?.state).toBe('debited');

    fake.seed('wager_withdrawals', [withdrawalRow({ id: 'w-2', state: 'confirmed' })]);
    await db.markWithdrawalSubmitted('w-2', SIGNED);
    await db.markWithdrawalFailed('w-2', 'boom');
    expect(fake.rows('wager_withdrawals')[1]).toMatchObject({ state: 'confirmed', error: null });
  });

  it('records failure with its error and rejects unsafe block heights', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_withdrawals', [withdrawalRow({ state: 'submitted' })]);
    await db.markWithdrawalFailed('w-1', 'blockhash expired');
    expect(fake.rows('wager_withdrawals')[0]).toMatchObject({ state: 'failed', error: 'blockhash expired' });
    await expect(
      db.markWithdrawalSubmitted('w-1', { ...SIGNED, last_valid_block_height: UNSAFE_INTEGER }),
    ).rejects.toThrow(DbError);
  });

  it('withdrawalsInState filters by state and converts lamports to bigint', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_withdrawals', [
      withdrawalRow(),
      withdrawalRow({ id: 'w-2', state: 'submitted', ...SIGNED }),
    ]);
    const debited = await db.withdrawalsInState('debited');
    expect(debited.map((row) => row.id)).toEqual(['w-1']);
    expect(debited[0]?.lamports).toBe(10_000_000n);
    fake.seed('wager_withdrawals', [withdrawalRow({ id: 'w-3', lamports: UNSAFE_INTEGER })]);
    await expect(db.withdrawalsInState('debited')).rejects.toThrow(DbError);
  });
});

describe('settlement applied marker', () => {
  it('insertSettlementApplied is upsert-ignore idempotent', async () => {
    const { db, fake } = makeHarness();
    expect(await db.hasSettlementApplied(MARKET_ID)).toBe(false);
    await db.insertSettlementApplied(MARKET_ID);
    await db.insertSettlementApplied(MARKET_ID);
    expect(fake.rows('wager_settlements_applied')).toHaveLength(1);
    expect(await db.hasSettlementApplied(MARKET_ID)).toBe(true);
  });

  it('getSettlementOutcome reads the shared settlements table', async () => {
    const { db, fake } = makeHarness();
    expect(await db.getSettlementOutcome(MARKET_ID)).toBeNull();
    fake.seed('settlements', [{ market_id: MARKET_ID, outcome: 'claim_won' }]);
    expect(await db.getSettlementOutcome(MARKET_ID)).toBe('claim_won');
  });

  it('settledSolMarketsMissingApplied anti-joins settled/voided SOL markets', async () => {
    const { db, fake } = makeHarness();
    fake.seed('markets', [
      { id: 'm-settled', currency: 'sol', status: 'settled' },
      { id: 'm-voided', currency: 'sol', status: 'voided' },
      { id: 'm-open', currency: 'sol', status: 'open' },
      { id: 'm-rep', currency: 'rep', status: 'settled' },
    ]);
    fake.seed('wager_settlements_applied', [{ market_id: 'm-voided', applied_at: NOW_ISO }]);
    expect(await db.settledSolMarketsMissingApplied()).toEqual(['m-settled']);

    const empty = makeHarness();
    expect(await empty.db.settledSolMarketsMissingApplied()).toEqual([]);
  });
});

describe('circuit breaker', () => {
  it('reads and flips the persisted wager_status row', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_status', [{ id: 1, paused: false, reason: null, updated_at: NOW_ISO }]);
    expect((await db.getWagerStatus()).paused).toBe(false);
    await db.setWagerStatus(true, 'solvency invariant violated');
    const status = await db.getWagerStatus();
    expect(status.paused).toBe(true);
    expect(status.reason).toBe('solvency invariant violated');
  });

  it('fails loud when the breaker row is missing', async () => {
    const { db } = makeHarness();
    await expect(db.getWagerStatus()).rejects.toThrow(DbError);
  });
});

describe('solvency queries', () => {
  it('openSolMarketIds returns non-terminal SOL markets only', async () => {
    const { db, fake } = makeHarness();
    fake.seed('markets', [
      { id: 'm-open', currency: 'sol', status: 'open' },
      { id: 'm-frozen', currency: 'sol', status: 'frozen' },
      { id: 'm-settled', currency: 'sol', status: 'settled' },
      { id: 'm-rep', currency: 'rep', status: 'open' },
    ]);
    expect(await db.openSolMarketIds()).toEqual(['m-open', 'm-frozen']);
  });
});

describe('security-definer RPCs', () => {
  const stakeInput: WagerStakeInput = {
    user_id: USER_ID,
    group_id: GROUP_ID,
    market_id: MARKET_ID,
    side: 'back',
    lamports: 10_000_000n,
    multiplier: 1.6,
    state: 'pending',
    placed_at_ms: 1_751_630_000_000,
  };

  it('forwards stake arguments under the SQL parameter names', async () => {
    const { db, fake } = makeHarness();
    fake.onRpc('wager_stake', () => ({ data: { ok: true, position_id: 'pos-1' }, error: null }));
    expect(await db.wagerStake(stakeInput)).toEqual({ ok: true, position_id: 'pos-1' });
    expect(fake.rpcCalls).toEqual([
      {
        fn: 'wager_stake',
        args: {
          p_user_id: USER_ID,
          p_group_id: GROUP_ID,
          p_market_id: MARKET_ID,
          p_side: 'back',
          p_lamports: 10_000_000, // bigint converted to a JSON-safe number
          p_multiplier: 1.6,
          p_state: 'pending',
          p_placed_at_ms: 1_751_630_000_000,
          p_idempotency_key: null, // absent on the button path
        },
      },
    ]);
  });

  it('forwards the client idempotency key and maps a duplicate reply', async () => {
    const { db, fake } = makeHarness();
    fake.onRpc('wager_stake', () => ({ data: { ok: true, duplicate: true }, error: null }));
    expect(await db.wagerStake({ ...stakeInput, idempotency_key: 'call-9' })).toEqual({
      ok: true,
      duplicate: true,
    });
    expect(fake.rpcCalls[0]?.args.p_idempotency_key).toBe('call-9');
  });

  it('maps every typed stake rejection code', async () => {
    const codes = ['insufficient', 'wrong_side', 'cap', 'paused'] as const;
    for (const code of codes) {
      const { db, fake } = makeHarness();
      fake.onRpc('wager_stake', () => ({ data: { ok: false, code }, error: null }));
      expect(await db.wagerStake(stakeInput)).toEqual({ ok: false, code });
    }
  });

  it('fails loud on SQL/TS drift: unknown codes and malformed payloads', async () => {
    const malformedPayloads: unknown[] = [
      { ok: false, code: 'not_a_real_code' },
      { ok: true }, // missing position_id
      { unexpected: true }, // missing ok flag
      'weird',
    ];
    for (const payload of malformedPayloads) {
      const { db, fake } = makeHarness();
      fake.onRpc('wager_stake', () => ({ data: payload, error: null }));
      await expect(db.wagerStake(stakeInput)).rejects.toThrow(DbError);
    }
    const { db, fake } = makeHarness();
    fake.onRpc('wager_stake', () => ({ data: null, error: { message: 'boom' } }));
    await expect(db.wagerStake(stakeInput)).rejects.toThrow(DbError);
  });

  it('rejects unsafe stake lamports before the RPC is ever invoked', async () => {
    const { db, fake } = makeHarness();
    fake.onRpc('wager_stake', () => ({ data: { ok: true, position_id: 'pos-1' }, error: null }));
    await expect(db.wagerStake({ ...stakeInput, lamports: UNSAFE_BIGINT })).rejects.toThrow(DbError);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('requestWithdrawal maps ok and typed rejection codes', async () => {
    const ok = makeHarness();
    ok.fake.onRpc('wager_request_withdrawal', (args) => {
      expect(args).toEqual({ p_user_id: USER_ID, p_lamports: 10_000_000 });
      return { data: { ok: true, withdrawal_id: 'w-1' }, error: null };
    });
    expect(await ok.db.requestWithdrawal({ user_id: USER_ID, lamports: 10_000_000n })).toEqual({
      ok: true,
      withdrawal_id: 'w-1',
    });

    for (const code of ['no_wallet', 'insufficient'] as const) {
      const { db, fake } = makeHarness();
      fake.onRpc('wager_request_withdrawal', () => ({ data: { ok: false, code }, error: null }));
      expect(await db.requestWithdrawal({ user_id: USER_ID, lamports: 10_000_000n })).toEqual({
        ok: false,
        code,
      });
    }

    const unsafe = makeHarness();
    await expect(
      unsafe.db.requestWithdrawal({ user_id: USER_ID, lamports: UNSAFE_BIGINT }),
    ).rejects.toThrow(DbError);
    expect(unsafe.fake.rpcCalls).toHaveLength(0);
  });
});
