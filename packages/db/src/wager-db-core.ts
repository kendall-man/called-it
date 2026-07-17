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

import type { MarketStatus } from '@calledit/market-engine';
import { assertOk, DbError, type PgResult } from './errors.js';
import type { RawDepositRow, RawWithdrawalRow } from './wager-db-row-parsers.js';
import type {
  WagerDepositRow,
  WagerStakeErrorCode,
  WagerWithdrawErrorCode,
  WagerWithdrawalRow,
  WagerWithdrawalState,
} from './wager-types.js';
import type {
  WagerDbClient,
} from './wager-db-contract.js';

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
  'wallet_unverified',
  'withdrawal_pending',
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
