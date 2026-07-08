/**
 * createWagerDb — data façade for wager mode (devnet SOL) over supabase-js.
 *
 * Mirrors the createEngineDb pattern: thin, typed, snake_case rows straight
 * from PostgREST, every business decision in the engine. Everything here
 * targets the wager_* tables from migrations/0002_wager.sql plus the
 * markets.currency column; the Rep-mode queries in engine-db.ts are
 * untouched. The surface structurally satisfies the engine's consumer port
 * (apps/engine/src/wager/port.ts WagerDb), so the wiring adapter is a
 * pass-through.
 *
 * Money safety at this boundary:
 * - Lamports cross the façade as BIGINT; PostgREST serializes bigint columns
 *   as JS numbers, so every conversion (either direction) passes a
 *   Number.isSafeInteger assert — precision loss fails loud instead of
 *   corrupting balances.
 * - Idempotency is structural: wager_ledger_entries.idempotency_key and
 *   wager_deposits (tx_sig, ix_index) are unique, and writes are
 *   upsert-ignore (same shape as postLedger in engine-db.ts).
 * - Stake/withdrawal atomicity lives in the security-definer RPCs
 *   (wager_stake / wager_request_withdrawal); this façade only forwards
 *   arguments and type-checks their jsonb results.
 */

import { createClient } from '@supabase/supabase-js';
import type { MarketStatus, SettlementOutcome } from '@calledit/market-engine';
import { assertOk, DbError, unwrapMaybe, unwrapRows, type PgResult } from './errors.js';
import type {
  LiabilityPosition,
  WagerDepositInsert,
  WagerDepositRow,
  WagerLedgerEntry,
  WagerStakeErrorCode,
  WagerStakeInput,
  WagerStakeResult,
  WagerStatusRow,
  WagerWalletLinkInsert,
  WagerWalletLinkRow,
  WagerWithdrawErrorCode,
  WagerWithdrawResult,
  WagerWithdrawalRow,
  WagerWithdrawalState,
  WalletLinkResult,
} from './wager-types.js';

// ── Shared quantization math (single JS mirror of the wager_stake SQL) ─────

/**
 * Multiplier quantization scale. MUST equal the `mult_scale constant bigint
 * := 1000` declaration in migrations/0002_wager.sql and MULT_SCALE in
 * apps/engine/src/wager/constants.ts — a parity test reads the migration
 * source and asserts this.
 */
export const WAGER_MULT_SCALE = 1000;

/**
 * mult_milli = round(multiplier × MULT_SCALE). Matches the SQL
 * `round(multiplier * 1000)::bigint`: both round in IEEE float64 and both
 * round positive halves up, so JS and Postgres always agree.
 */
export function multMilli(multiplier: number): bigint {
  const scaled = Math.round(multiplier * WAGER_MULT_SCALE);
  if (!Number.isSafeInteger(scaled) || scaled < 0) {
    throw new DbError('multMilli', { message: `invalid multiplier: ${multiplier}` });
  }
  return BigInt(scaled);
}

/**
 * payout = floor(stake × mult_milli / MULT_SCALE). BigInt division truncates
 * toward zero, which is floor for the non-negative inputs used here —
 * identical to the SQL's bigint division.
 */
export function stakePayoutLamports(stakeLamports: bigint, multMilliValue: bigint): bigint {
  return (stakeLamports * multMilliValue) / BigInt(WAGER_MULT_SCALE);
}

/**
 * Worst-case treasury exposure for one market over non-void positions:
 * max over sides of Σ payout, minus Σ all stakes escrowed in the pool.
 * Negative means the pool covers every outcome. Mirrors the liability check
 * inside the wager_stake SQL exactly (same rounding, same integer division).
 */
export function worstCaseLiabilityLamports(positions: readonly LiabilityPosition[]): bigint {
  let backPayout = 0n;
  let doubtPayout = 0n;
  let totalStakes = 0n;
  for (const position of positions) {
    if (position.state === 'void') continue;
    const stake = lamportsFromDb('worstCaseLiabilityLamports', position.stake);
    const payout = stakePayoutLamports(stake, multMilli(position.locked_multiplier));
    if (position.side === 'back') backPayout += payout;
    else doubtPayout += payout;
    totalStakes += stake;
  }
  const maxPayout = backPayout > doubtPayout ? backPayout : doubtPayout;
  return maxPayout - totalStakes;
}

// ── Safe-integer boundary asserts (bigint ↔ PostgREST number) ──────────────

/**
 * Guard for every bigint→number crossing: PostgREST parses bigint into a JS
 * double, which silently loses precision past 2^53. Throws DbError so the
 * failure surfaces as loudly as any other database fault.
 */
export function assertSafeInteger(op: string, value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new DbError(op, { message: `value ${value} is not a safe integer` });
  }
  return value;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** DB → façade: bigint from a PostgREST number, asserting no precision loss. */
function lamportsFromDb(op: string, value: number): bigint {
  return BigInt(assertSafeInteger(op, value));
}

/** Façade → DB: PostgREST JSON needs a number; assert the bigint fits one. */
function lamportsToDb(op: string, value: bigint): number {
  if (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT) {
    throw new DbError(op, { message: `lamports ${value} exceed the Number-safe range` });
  }
  return Number(value);
}

// ── Constants (mirroring CHECK constraints / engine semantics) ─────────────

/** Postgres unique_violation — linkWallet maps it to first-link-wins. */
const UNIQUE_VIOLATION = '23505';

/** Market statuses still open for staking; mirrors engine-db.ts (not exported there). */
const OPEN_MARKET_STATUSES: readonly MarketStatus[] = [
  'pending_lineup',
  'open',
  'frozen',
  'settling',
];

/** Terminal statuses whose SOL money movement the settlement sweeper owns. */
const SETTLED_MARKET_STATUSES: readonly MarketStatus[] = ['settled', 'voided'];

/** Outbox states from which the executor may (re-)sign or fail a withdrawal. */
const RESIGNABLE_WITHDRAWAL_STATES: readonly WagerWithdrawalState[] = ['debited', 'submitted'];

/** Fixed primary key of the single wager_status circuit-breaker row. */
const WAGER_STATUS_ROW_ID = 1;

function nowIso(): string {
  return new Date().toISOString();
}

// ── Minimal structural client (lets tests inject an in-memory fake) ────────

type Row = Record<string, unknown>;

export interface WagerFilterBuilder extends PromiseLike<PgResult<Row[]>> {
  eq(column: string, value: unknown): WagerFilterBuilder;
  in(column: string, values: readonly unknown[]): WagerFilterBuilder;
  is(column: string, value: null): WagerFilterBuilder;
  select(columns?: string): WagerFilterBuilder;
  maybeSingle(): PromiseLike<PgResult<Row | null>>;
}

export interface WagerTableBuilder {
  select(columns?: string): WagerFilterBuilder;
  upsert(
    values: object,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): WagerFilterBuilder;
  update(values: object): WagerFilterBuilder;
  delete(): WagerFilterBuilder;
}

/**
 * The slice of SupabaseClient the wager façade actually uses. Hermetic tests
 * implement this shape in memory; production passes the real client through
 * one contained cast in createWagerDb.
 */
export interface WagerDbClient {
  from(table: string): WagerTableBuilder;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<PgResult<unknown>>;
}

async function manyRows<T>(op: string, query: PromiseLike<PgResult<Row[]>>): Promise<T> {
  return unwrapRows<T>(op, (await query) as PgResult<T>);
}

async function maybeRow<T>(op: string, query: PromiseLike<PgResult<Row | null>>): Promise<T | null> {
  return unwrapMaybe<T>(op, (await query) as PgResult<T>);
}

// ── Raw row shapes (lamports still PostgREST numbers) and converters ───────

interface RawDepositRow {
  id: number;
  tx_sig: string;
  ix_index: number;
  sender_pubkey: string;
  lamports: number;
  slot: number;
  user_id: number | null;
  credited_at: string | null;
  observed_at: string;
}

function depositFromRaw(op: string, raw: RawDepositRow): WagerDepositRow {
  return {
    ...raw,
    lamports: lamportsFromDb(op, raw.lamports),
    slot: assertSafeInteger(op, raw.slot),
  };
}

interface RawWithdrawalRow {
  id: string;
  user_id: number;
  dest_pubkey: string;
  lamports: number;
  state: WagerWithdrawalState;
  tx_sig: string | null;
  raw_tx_b64: string | null;
  last_valid_block_height: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function withdrawalFromRaw(op: string, raw: RawWithdrawalRow): WagerWithdrawalRow {
  if (raw.last_valid_block_height !== null) assertSafeInteger(op, raw.last_valid_block_height);
  return { ...raw, lamports: lamportsFromDb(op, raw.lamports) };
}

// ── RPC result parsing ─────────────────────────────────────────────────────

const STAKE_ERROR_CODES: ReadonlySet<string> = new Set<WagerStakeErrorCode>([
  'insufficient',
  'wrong_side',
  'cap',
  'liability_cap',
  'paused',
]);

const WITHDRAW_ERROR_CODES: ReadonlySet<string> = new Set<WagerWithdrawErrorCode>([
  'no_wallet',
  'insufficient',
]);

/**
 * Validate the jsonb payload of a wager RPC. Strict on purpose: an
 * unrecognized code or malformed shape means the SQL and TS sides drifted,
 * which must fail loud rather than map to a default branch.
 */
function parseRpcOutcome<C extends string>(
  op: string,
  payload: unknown,
  idField: string,
  codes: ReadonlySet<string>,
): { ok: true; id: string } | { ok: false; code: C } {
  if (typeof payload !== 'object' || payload === null) {
    throw new DbError(op, { message: `malformed RPC payload: ${JSON.stringify(payload)}` });
  }
  const record = payload as Record<string, unknown>;
  if (record.ok === true) {
    const id = record[idField];
    if (typeof id !== 'string') {
      throw new DbError(op, { message: `RPC ok payload missing ${idField}` });
    }
    return { ok: true, id };
  }
  if (record.ok === false) {
    const code = record.code;
    if (typeof code === 'string' && codes.has(code)) {
      return { ok: false, code: code as C };
    }
    throw new DbError(op, { message: `unrecognized RPC error code: ${String(code)}` });
  }
  throw new DbError(op, { message: 'malformed RPC payload: missing ok flag' });
}

// ── Façade interface ───────────────────────────────────────────────────────

export interface WagerDb {
  // group opt-in
  setGroupEnabled(groupId: number, enabled: boolean, byUserId: number): Promise<void>;
  isGroupEnabled(groupId: number): Promise<boolean>;

  // wallet links
  getWalletLink(userId: number): Promise<WagerWalletLinkRow | null>;
  getWalletLinkByPubkey(pubkey: string): Promise<WagerWalletLinkRow | null>;
  /**
   * Upsert on user_id (re-linking moves future attribution and resets
   * verification); pubkey_taken when another user already claimed the pubkey
   * (first-link-wins via the unique constraint).
   */
  linkWallet(input: WagerWalletLinkInsert): Promise<WalletLinkResult>;
  setLastWagerGroup(userId: number, groupId: number): Promise<void>;
  /** Stamps verified_at once (first credited deposit); later calls no-op. */
  markWalletVerified(userId: number): Promise<void>;
  /** Ops escape hatch for the accepted link-squatting risk. */
  unlinkWallet(userId: number): Promise<void>;

  // ledger (user-global lamport balances)
  /** Idempotent append; inserted=false when the idempotency key already exists. */
  postWagerLedger(entry: WagerLedgerEntry): Promise<{ inserted: boolean }>;
  /** User-global balance (sum of all ledger rows for the user). */
  balanceLamports(userId: number): Promise<bigint>;
  /** Σ over ALL wager_ledger_entries — total user credit the treasury owes. */
  totalLedgerLamports(): Promise<bigint>;

  // deposits (idempotent on UNIQUE(tx_sig, ix_index))
  upsertDeposit(row: WagerDepositInsert): Promise<{ inserted: boolean }>;
  /** Attribute a deposit exactly once; re-credits never move attribution. */
  markDepositCredited(txSig: string, ixIndex: number, userId: number): Promise<void>;
  /** Uncredited rows (user_id null) from this sender — the /wallet link sweep. */
  orphanDepositsBySender(pubkey: string): Promise<WagerDepositRow[]>;

  // withdrawals outbox
  withdrawalsInState(state: WagerWithdrawalState): Promise<WagerWithdrawalRow[]>;
  /**
   * Persist signed-tx facts and flip to 'submitted' BEFORE broadcast. Legal
   * from 'debited' (first sign) and 'submitted' (re-sign after blockheight
   * expiry); any other state no-ops so terminal rows stay immutable.
   */
  markWithdrawalSubmitted(
    id: string,
    tx: { tx_sig: string; raw_tx_b64: string; last_valid_block_height: number },
  ): Promise<void>;
  /** Legal only from 'submitted'; no-ops otherwise. */
  markWithdrawalConfirmed(id: string): Promise<void>;
  /** Legal from 'debited'/'submitted'; the caller posts the withdrawal_refund credit. */
  markWithdrawalFailed(id: string, error: string): Promise<void>;

  // settlements (money-movement marker, separate from settlements.posted_at)
  getSettlementOutcome(marketId: string): Promise<SettlementOutcome | null>;
  hasSettlementApplied(marketId: string): Promise<boolean>;
  /** Upsert-ignore on market_id; duplicates no-op. */
  insertSettlementApplied(marketId: string): Promise<void>;
  /** Settled/voided SOL markets missing the applied marker (sweeper input). */
  settledSolMarketsMissingApplied(): Promise<string[]>;

  // circuit breaker (wager_status single row)
  getWagerStatus(): Promise<WagerStatusRow>;
  setWagerStatus(paused: boolean, reason: string | null): Promise<void>;

  // solvency support
  /** Open SOL markets whose worst-case liability the solvency cron sums. */
  openSolMarketIds(): Promise<string[]>;

  // atomic security-definer RPCs (pg_advisory_xact_lock per user inside)
  wagerStake(args: WagerStakeInput): Promise<WagerStakeResult>;
  /** dest_pubkey is resolved from the wallet link INSIDE the function. */
  requestWithdrawal(args: { user_id: number; lamports: bigint }): Promise<WagerWithdrawResult>;
}

// ── Factories ──────────────────────────────────────────────────────────────

export function createWagerDb(url: string, serviceRoleKey: string): WagerDb {
  // Service-role key bypasses RLS; this client must only ever live server-side.
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // One contained cast: the façade codes against the minimal structural
  // WagerDbClient slice so tests can inject an in-memory fake.
  return wagerDbFromClient(client as unknown as WagerDbClient);
}

export function wagerDbFromClient(client: WagerDbClient): WagerDb {
  return {
    // ── group opt-in ───────────────────────────────────────────────────────

    async setGroupEnabled(groupId, enabled, byUserId) {
      assertOk(
        'setGroupEnabled',
        await client.from('wager_groups').upsert(
          { group_id: groupId, enabled, enabled_by: byUserId, updated_at: nowIso() },
          { onConflict: 'group_id' },
        ),
      );
    },

    async isGroupEnabled(groupId) {
      const row = await maybeRow<{ enabled: boolean }>(
        'isGroupEnabled',
        client.from('wager_groups').select('enabled').eq('group_id', groupId).maybeSingle(),
      );
      return row?.enabled ?? false;
    },

    // ── wallet links ───────────────────────────────────────────────────────

    async getWalletLink(userId) {
      return maybeRow<WagerWalletLinkRow>(
        'getWalletLink',
        client.from('wager_wallet_links').select('*').eq('user_id', userId).maybeSingle(),
      );
    },

    async getWalletLinkByPubkey(pubkey) {
      return maybeRow<WagerWalletLinkRow>(
        'getWalletLinkByPubkey',
        client.from('wager_wallet_links').select('*').eq('pubkey', pubkey).maybeSingle(),
      );
    },

    async linkWallet(input) {
      // Lookup-then-upsert: the lookup only feeds the cosmetic relinked flag,
      // so its benign race window costs nothing. verified_at resets on every
      // (re-)link — verification belongs to the linked pubkey, not the user.
      const existing = await maybeRow<{ pubkey: string }>(
        'linkWallet.lookup',
        client.from('wager_wallet_links').select('pubkey').eq('user_id', input.user_id).maybeSingle(),
      );
      const row: Row = { user_id: input.user_id, pubkey: input.pubkey, verified_at: null };
      if (input.last_wager_group_id !== undefined) {
        row.last_wager_group_id = input.last_wager_group_id;
      }
      const result = await client
        .from('wager_wallet_links')
        .upsert(row, { onConflict: 'user_id' });
      if (result.error?.code === UNIQUE_VIOLATION) return { ok: false, reason: 'pubkey_taken' };
      assertOk('linkWallet', result);
      return { ok: true, relinked: existing !== null && existing.pubkey !== input.pubkey };
    },

    async setLastWagerGroup(userId, groupId) {
      assertOk(
        'setLastWagerGroup',
        await client
          .from('wager_wallet_links')
          .update({ last_wager_group_id: groupId })
          .eq('user_id', userId),
      );
    },

    async markWalletVerified(userId) {
      // .is(null) guard keeps the FIRST verification timestamp.
      assertOk(
        'markWalletVerified',
        await client
          .from('wager_wallet_links')
          .update({ verified_at: nowIso() })
          .eq('user_id', userId)
          .is('verified_at', null),
      );
    },

    async unlinkWallet(userId) {
      assertOk(
        'unlinkWallet',
        await client.from('wager_wallet_links').delete().eq('user_id', userId),
      );
    },

    // ── ledger ─────────────────────────────────────────────────────────────

    async postWagerLedger(entry) {
      const rows = await manyRows<Array<{ id: number }>>(
        'postWagerLedger',
        client
          .from('wager_ledger_entries')
          .upsert(
            { ...entry, lamports: lamportsToDb('postWagerLedger.lamports', entry.lamports) },
            { onConflict: 'idempotency_key', ignoreDuplicates: true },
          )
          .select('id'),
      );
      return { inserted: rows.length > 0 };
    },

    async balanceLamports(userId) {
      const rows = await manyRows<Array<{ lamports: number }>>(
        'balanceLamports',
        client.from('wager_ledger_entries').select('lamports').eq('user_id', userId),
      );
      return rows.reduce((sum, row) => sum + lamportsFromDb('balanceLamports', row.lamports), 0n);
    },

    async totalLedgerLamports() {
      const rows = await manyRows<Array<{ lamports: number }>>(
        'totalLedgerLamports',
        client.from('wager_ledger_entries').select('lamports'),
      );
      return rows.reduce(
        (sum, row) => sum + lamportsFromDb('totalLedgerLamports', row.lamports),
        0n,
      );
    },

    // ── deposits ───────────────────────────────────────────────────────────

    async upsertDeposit(row) {
      assertSafeInteger('upsertDeposit.slot', row.slot);
      const rows = await manyRows<Array<{ id: number }>>(
        'upsertDeposit',
        client
          .from('wager_deposits')
          .upsert(
            { ...row, lamports: lamportsToDb('upsertDeposit.lamports', row.lamports) },
            { onConflict: 'tx_sig,ix_index', ignoreDuplicates: true },
          )
          .select('id'),
      );
      return { inserted: rows.length > 0 };
    },

    async markDepositCredited(txSig, ixIndex, userId) {
      // .is(null) guard: a deposit row is credited exactly once. The ledger's
      // idempotency key is the money guard; this keeps attribution stable.
      assertOk(
        'markDepositCredited',
        await client
          .from('wager_deposits')
          .update({ user_id: userId, credited_at: nowIso() })
          .eq('tx_sig', txSig)
          .eq('ix_index', ixIndex)
          .is('credited_at', null),
      );
    },

    async orphanDepositsBySender(pubkey) {
      const rows = await manyRows<RawDepositRow[]>(
        'orphanDepositsBySender',
        client
          .from('wager_deposits')
          .select('*')
          .eq('sender_pubkey', pubkey)
          .is('user_id', null),
      );
      return rows.map((row) => depositFromRaw('orphanDepositsBySender', row));
    },

    // ── withdrawals outbox ─────────────────────────────────────────────────

    async withdrawalsInState(state) {
      const rows = await manyRows<RawWithdrawalRow[]>(
        'withdrawalsInState',
        client.from('wager_withdrawals').select('*').eq('state', state),
      );
      return rows.map((row) => withdrawalFromRaw('withdrawalsInState', row));
    },

    async markWithdrawalSubmitted(id, tx) {
      assertSafeInteger('markWithdrawalSubmitted.last_valid_block_height', tx.last_valid_block_height);
      assertOk(
        'markWithdrawalSubmitted',
        await client
          .from('wager_withdrawals')
          .update({
            state: 'submitted' satisfies WagerWithdrawalState,
            tx_sig: tx.tx_sig,
            raw_tx_b64: tx.raw_tx_b64,
            last_valid_block_height: tx.last_valid_block_height,
            updated_at: nowIso(),
          })
          .eq('id', id)
          .in('state', [...RESIGNABLE_WITHDRAWAL_STATES]),
      );
    },

    async markWithdrawalConfirmed(id) {
      assertOk(
        'markWithdrawalConfirmed',
        await client
          .from('wager_withdrawals')
          .update({ state: 'confirmed' satisfies WagerWithdrawalState, updated_at: nowIso() })
          .eq('id', id)
          .in('state', ['submitted' satisfies WagerWithdrawalState]),
      );
    },

    async markWithdrawalFailed(id, error) {
      assertOk(
        'markWithdrawalFailed',
        await client
          .from('wager_withdrawals')
          .update({ state: 'failed' satisfies WagerWithdrawalState, error, updated_at: nowIso() })
          .eq('id', id)
          .in('state', [...RESIGNABLE_WITHDRAWAL_STATES]),
      );
    },

    // ── settlements (money-movement marker) ────────────────────────────────

    async getSettlementOutcome(marketId) {
      const row = await maybeRow<{ outcome: SettlementOutcome }>(
        'getSettlementOutcome',
        client.from('settlements').select('outcome').eq('market_id', marketId).maybeSingle(),
      );
      return row?.outcome ?? null;
    },

    async hasSettlementApplied(marketId) {
      const row = await maybeRow<{ market_id: string }>(
        'hasSettlementApplied',
        client
          .from('wager_settlements_applied')
          .select('market_id')
          .eq('market_id', marketId)
          .maybeSingle(),
      );
      return row !== null;
    },

    async insertSettlementApplied(marketId) {
      assertOk(
        'insertSettlementApplied',
        await client
          .from('wager_settlements_applied')
          .upsert({ market_id: marketId }, { onConflict: 'market_id', ignoreDuplicates: true }),
      );
    },

    async settledSolMarketsMissingApplied() {
      // Two-step anti-join: PostgREST has no NOT EXISTS, and both sets stay
      // tiny (SOL markets only).
      const settled = await manyRows<Array<{ id: string }>>(
        'settledSolMarketsMissingApplied.markets',
        client
          .from('markets')
          .select('id')
          .eq('currency', 'sol')
          .in('status', [...SETTLED_MARKET_STATUSES]),
      );
      if (settled.length === 0) return [];
      const ids = settled.map((row) => row.id);
      const applied = await manyRows<Array<{ market_id: string }>>(
        'settledSolMarketsMissingApplied.applied',
        client.from('wager_settlements_applied').select('market_id').in('market_id', ids),
      );
      const appliedIds = new Set(applied.map((row) => row.market_id));
      return ids.filter((id) => !appliedIds.has(id));
    },

    // ── circuit breaker ────────────────────────────────────────────────────

    async getWagerStatus() {
      const row = await maybeRow<WagerStatusRow>(
        'getWagerStatus',
        client
          .from('wager_status')
          .select('paused, reason, updated_at')
          .eq('id', WAGER_STATUS_ROW_ID)
          .maybeSingle(),
      );
      if (!row) {
        throw new DbError('getWagerStatus', {
          message: 'wager_status row missing — apply migration 0002',
        });
      }
      return row;
    },

    async setWagerStatus(paused, reason) {
      assertOk(
        'setWagerStatus',
        await client
          .from('wager_status')
          .update({ paused, reason, updated_at: nowIso() })
          .eq('id', WAGER_STATUS_ROW_ID),
      );
    },

    // ── solvency support ───────────────────────────────────────────────────

    async openSolMarketIds() {
      const rows = await manyRows<Array<{ id: string }>>(
        'openSolMarketIds',
        client
          .from('markets')
          .select('id')
          .eq('currency', 'sol')
          .in('status', [...OPEN_MARKET_STATUSES]),
      );
      return rows.map((row) => row.id);
    },

    // ── security-definer RPCs ──────────────────────────────────────────────

    async wagerStake(args) {
      assertSafeInteger('wagerStake.placed_at_ms', args.placed_at_ms);
      const result = await client.rpc('wager_stake', {
        p_user_id: args.user_id,
        p_group_id: args.group_id,
        p_market_id: args.market_id,
        p_side: args.side,
        p_lamports: lamportsToDb('wagerStake.lamports', args.lamports),
        p_multiplier: args.multiplier,
        p_state: args.state,
        p_placed_at_ms: args.placed_at_ms,
      });
      const payload = unwrapRows<unknown>('wager_stake', result);
      const outcome = parseRpcOutcome<WagerStakeErrorCode>(
        'wager_stake',
        payload,
        'position_id',
        STAKE_ERROR_CODES,
      );
      return outcome.ok ? { ok: true, position_id: outcome.id } : outcome;
    },

    async requestWithdrawal(args) {
      const result = await client.rpc('wager_request_withdrawal', {
        p_user_id: args.user_id,
        p_lamports: lamportsToDb('requestWithdrawal.lamports', args.lamports),
      });
      const payload = unwrapRows<unknown>('wager_request_withdrawal', result);
      const outcome = parseRpcOutcome<WagerWithdrawErrorCode>(
        'wager_request_withdrawal',
        payload,
        'withdrawal_id',
        WITHDRAW_ERROR_CODES,
      );
      return outcome.ok ? { ok: true, withdrawal_id: outcome.id } : outcome;
    },
  };
}
