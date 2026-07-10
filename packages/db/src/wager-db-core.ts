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

import type { MarketStatus, SettlementOutcome } from '@calledit/market-engine';
import { assertOk, DbError, type PgResult } from './errors.js';
import type { RawDepositRow, RawWithdrawalRow } from './wager-db-row-parsers.js';
import type {
  WagerDepositInsert,
  WagerDepositRow,
  WagerLedgerEntry,
  CreatePendingStakeIntentResult,
  MutatePendingStakeIntentResult,
  PendingStakeIntentInput,
  WagerStakeErrorCode,
  WagerStakeInput,
  WagerStakeResult,
  WagerStatusRow,
  ResolvePendingStakeIntentResult,
  VerifiedWalletLinkInput,
  VerifiedWalletLinkResult,
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
export function lamportsFromDb(op: string, value: number): bigint {
  return BigInt(assertSafeInteger(op, value));
}

/** Façade → DB: PostgREST JSON needs a number; assert the bigint fits one. */
export function lamportsToDb(op: string, value: bigint): number {
  if (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT) {
    throw new DbError(op, { message: `lamports ${value} exceed the Number-safe range` });
  }
  return Number(value);
}

// ── Constants (mirroring CHECK constraints / engine semantics) ─────────────

/** Postgres unique_violation — linkWallet maps it to first-link-wins. */
export const UNIQUE_VIOLATION = '23505';

/** Non-terminal SOL market statuses used by solvency scans; stake RPCs still gate entry. */
export const OPEN_MARKET_STATUSES: readonly MarketStatus[] = [
  'pending_lineup',
  'open',
  'frozen',
  'settling',
];

/** Terminal statuses whose SOL money movement the settlement sweeper owns. */
export const SETTLED_MARKET_STATUSES: readonly MarketStatus[] = ['settled', 'voided'];

/** Outbox states from which the executor may (re-)sign or fail a withdrawal. */
export const RESIGNABLE_WITHDRAWAL_STATES: readonly WagerWithdrawalState[] = ['debited', 'submitted'];

/** Fixed primary key of the single wager_status circuit-breaker row. */
export const WAGER_STATUS_ROW_ID = 1;

export function nowIso(): string {
  return new Date().toISOString();
}

// ── Minimal structural client (lets tests inject an in-memory fake) ────────

export type Row = Record<string, unknown>;

export interface WagerFilterBuilder extends PromiseLike<PgResult<unknown>> {
  eq(column: string, value: unknown): WagerFilterBuilder;
  in(column: string, values: readonly unknown[]): WagerFilterBuilder;
  is(column: string, value: null): WagerFilterBuilder;
  select(columns?: string): WagerFilterBuilder;
  maybeSingle(): PromiseLike<PgResult<unknown>>;
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
 * implement this shape in memory; production clients are accepted by structure.
 */
export interface WagerDbClient {
  from(table: string): WagerTableBuilder;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<PgResult<unknown>>;
}

function isWagerDbClient(value: unknown): value is WagerDbClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    'from' in value &&
    typeof value.from === 'function' &&
    'rpc' in value &&
    typeof value.rpc === 'function'
  );
}

export function requireWagerDbClient(value: unknown): WagerDbClient {
  if (!isWagerDbClient(value)) {
    throw new DbError('createWagerDb', { message: 'malformed Supabase client' });
  }
  return value;
}

// ── Raw row shapes (lamports still PostgREST numbers) and converters ───────

export function depositFromRaw(op: string, raw: RawDepositRow): WagerDepositRow {
  return {
    ...raw,
    lamports: lamportsFromDb(op, raw.lamports),
    slot: assertSafeInteger(op, raw.slot),
  };
}

export function withdrawalFromRaw(op: string, raw: RawWithdrawalRow): WagerWithdrawalRow {
  if (raw.last_valid_block_height !== null) assertSafeInteger(op, raw.last_valid_block_height);
  return { ...raw, lamports: lamportsFromDb(op, raw.lamports) };
}

// ── RPC result parsing ─────────────────────────────────────────────────────

const STAKE_ERROR_CODES: ReadonlySet<unknown> = new Set<WagerStakeErrorCode>([
  'insufficient',
  'wrong_side',
  'cap',
  'paused',
  'closed',
  'starter_unavailable',
  'budget_exhausted',
  'wallet_required',
]);

const WITHDRAW_ERROR_CODES: ReadonlySet<unknown> = new Set<WagerWithdrawErrorCode>([
  'no_wallet',
  'insufficient',
]);

/**
 * Validate the jsonb payload of a wager RPC. Strict on purpose: an
 * unrecognized code or malformed shape means the SQL and TS sides drifted,
 * which must fail loud rather than map to a default branch.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStakeErrorCode(value: unknown): value is WagerStakeErrorCode {
  return STAKE_ERROR_CODES.has(value);
}

export function isWithdrawErrorCode(value: unknown): value is WagerWithdrawErrorCode {
  return WITHDRAW_ERROR_CODES.has(value);
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseRpcOutcome<C extends string>(
  op: string,
  payload: unknown,
  idField: string,
  isCode: (value: unknown) => value is C,
  isId: (value: unknown) => value is string,
): { ok: true; id: string } | { ok: true; duplicate: true } | { ok: false; code: C } {
  if (!isRecord(payload)) {
    throw new DbError(op, { message: `malformed RPC payload: ${JSON.stringify(payload)}` });
  }
  if (payload.ok === true) {
    if (payload.duplicate === true) {
      if (idField in payload) {
        throw new DbError(op, { message: `RPC duplicate payload also includes ${idField}` });
      }
      return { ok: true, duplicate: true };
    }
    const id = payload[idField];
    if (!isId(id)) {
      throw new DbError(op, { message: `RPC ok payload missing or invalid ${idField}` });
    }
    return { ok: true, id };
  }
  if (payload.ok === false) {
    if (isCode(payload.code)) {
      return { ok: false, code: payload.code };
    }
    throw new DbError(op, { message: `unrecognized RPC error code: ${String(payload.code)}` });
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
  /** Feed-locked probability of the market (the peer-match ratio input). */
  getMarketProbability(marketId: string): Promise<number | null>;
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

  verifyWalletLink(args: VerifiedWalletLinkInput): Promise<VerifiedWalletLinkResult>;
  createPendingStakeIntent(args: PendingStakeIntentInput): Promise<CreatePendingStakeIntentResult>;
  resolveActiveStakeIntent(userId: number): Promise<ResolvePendingStakeIntentResult>;
  markStakeIntentFunded(userId: number, intentId: string): Promise<MutatePendingStakeIntentResult>;
  consumeReadyStakeIntent(userId: number, intentId: string): Promise<ResolvePendingStakeIntentResult>;
  cancelStakeIntent(userId: number, intentId: string): Promise<MutatePendingStakeIntentResult>;
}
