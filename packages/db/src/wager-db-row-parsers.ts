import type { SettlementOutcome } from '@calledit/market-engine';
import { DbError, unwrapMaybe, unwrapRows, type PgResult } from './errors.js';
import type {
  PendingStakeIntentState,
  WagerStatusRow,
  WagerWalletLinkRow,
  WagerWithdrawalState,
} from './wager-types.js';

type DatabaseRow = Readonly<Record<string, unknown>>;
export type RowParser<T> = (op: string, value: unknown) => T;

function malformed(op: string, field: string): never {
  throw new DbError(op, { message: `malformed database row field: ${field}` });
}

function isDatabaseRow(value: unknown): value is DatabaseRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(op: string, value: unknown): DatabaseRow {
  if (!isDatabaseRow(value)) {
    return malformed(op, '<row>');
  }
  return value;
}

function stringField(op: string, row: DatabaseRow, field: string): string {
  const value = row[field];
  return typeof value === 'string' ? value : malformed(op, field);
}

function numberField(op: string, row: DatabaseRow, field: string): number {
  const value = row[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : malformed(op, field);
}

function integerField(op: string, row: DatabaseRow, field: string): number {
  const value = row[field];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : malformed(op, field);
}

function booleanField(op: string, row: DatabaseRow, field: string): boolean {
  const value = row[field];
  return typeof value === 'boolean' ? value : malformed(op, field);
}

function nullableStringField(op: string, row: DatabaseRow, field: string): string | null {
  const value = row[field];
  return value === null || typeof value === 'string' ? value : malformed(op, field);
}

function nullableIntegerField(op: string, row: DatabaseRow, field: string): number | null {
  const value = row[field];
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value))
    ? value
    : malformed(op, field);
}

function isSettlementOutcome(value: unknown): value is SettlementOutcome {
  return value === 'claim_won' || value === 'claim_lost' || value === 'void';
}

function isWithdrawalState(value: unknown): value is WagerWithdrawalState {
  return value === 'debited' || value === 'submitted' || value === 'confirmed' || value === 'failed';
}

function isPositionSide(value: unknown): value is 'back' | 'doubt' {
  return value === 'back' || value === 'doubt';
}

function isPendingStakeIntentState(value: unknown): value is PendingStakeIntentState {
  return (
    value === 'pending' ||
    value === 'awaiting_funds' ||
    value === 'ready' ||
    value === 'consumed' ||
    value === 'expired' ||
    value === 'cancelled'
  );
}

export async function manyRows<T>(
  op: string,
  query: PromiseLike<PgResult<unknown>>,
  parse: RowParser<T>,
): Promise<T[]> {
  const value = unwrapRows<unknown>(op, await query);
  if (!Array.isArray(value)) return malformed(op, '<rows>');
  return value.map((row) => parse(op, row));
}

export async function maybeRow<T>(
  op: string,
  query: PromiseLike<PgResult<unknown>>,
  parse: RowParser<T>,
): Promise<T | null> {
  const value = unwrapMaybe<unknown>(op, await query);
  return value === null ? null : parse(op, value);
}

export function parseEnabledRow(op: string, value: unknown): { readonly enabled: boolean } {
  const row = record(op, value);
  return { enabled: booleanField(op, row, 'enabled') };
}

export function parseWalletLinkRow(op: string, value: unknown): WagerWalletLinkRow {
  const row = record(op, value);
  return {
    user_id: integerField(op, row, 'user_id'),
    pubkey: stringField(op, row, 'pubkey'),
    last_wager_group_id: nullableIntegerField(op, row, 'last_wager_group_id'),
    verified_at: nullableStringField(op, row, 'verified_at'),
    created_at: stringField(op, row, 'created_at'),
  };
}

export function parsePubkeyRow(op: string, value: unknown): { readonly pubkey: string } {
  const row = record(op, value);
  return { pubkey: stringField(op, row, 'pubkey') };
}

export function parseNumericIdRow(op: string, value: unknown): { readonly id: number } {
  const row = record(op, value);
  return { id: integerField(op, row, 'id') };
}

export function parseLamportsRow(op: string, value: unknown): { readonly lamports: number } {
  const row = record(op, value);
  return { lamports: integerField(op, row, 'lamports') };
}

export interface RawDepositRow {
  readonly id: number;
  readonly tx_sig: string;
  readonly ix_index: number;
  readonly sender_pubkey: string;
  readonly lamports: number;
  readonly slot: number;
  readonly user_id: number | null;
  readonly credited_at: string | null;
  readonly observed_at: string;
}

export function parseDepositRow(op: string, value: unknown): RawDepositRow {
  const row = record(op, value);
  return {
    id: integerField(op, row, 'id'),
    tx_sig: stringField(op, row, 'tx_sig'),
    ix_index: integerField(op, row, 'ix_index'),
    sender_pubkey: stringField(op, row, 'sender_pubkey'),
    lamports: integerField(op, row, 'lamports'),
    slot: integerField(op, row, 'slot'),
    user_id: nullableIntegerField(op, row, 'user_id'),
    credited_at: nullableStringField(op, row, 'credited_at'),
    observed_at: stringField(op, row, 'observed_at'),
  };
}

export interface RawWithdrawalRow {
  readonly id: string;
  readonly user_id: number;
  readonly dest_pubkey: string;
  readonly lamports: number;
  readonly state: WagerWithdrawalState;
  readonly tx_sig: string | null;
  readonly raw_tx_b64: string | null;
  readonly last_valid_block_height: number | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export function parseWithdrawalRow(op: string, value: unknown): RawWithdrawalRow {
  const row = record(op, value);
  const state = row.state;
  if (!isWithdrawalState(state)) return malformed(op, 'state');
  return {
    id: stringField(op, row, 'id'),
    user_id: integerField(op, row, 'user_id'),
    dest_pubkey: stringField(op, row, 'dest_pubkey'),
    lamports: integerField(op, row, 'lamports'),
    state,
    tx_sig: nullableStringField(op, row, 'tx_sig'),
    raw_tx_b64: nullableStringField(op, row, 'raw_tx_b64'),
    last_valid_block_height: nullableIntegerField(op, row, 'last_valid_block_height'),
    error: nullableStringField(op, row, 'error'),
    created_at: stringField(op, row, 'created_at'),
    updated_at: stringField(op, row, 'updated_at'),
  };
}

export function parseProbabilityRow(
  op: string,
  value: unknown,
): { readonly quote_probability: number } {
  const row = record(op, value);
  return { quote_probability: numberField(op, row, 'quote_probability') };
}

export function parseSettlementOutcomeRow(
  op: string,
  value: unknown,
): { readonly outcome: SettlementOutcome } {
  const row = record(op, value);
  const outcome = row.outcome;
  if (!isSettlementOutcome(outcome)) return malformed(op, 'outcome');
  return { outcome };
}

export function parseMarketIdRow(op: string, value: unknown): { readonly market_id: string } {
  const row = record(op, value);
  return { market_id: stringField(op, row, 'market_id') };
}

export function parseIdRow(op: string, value: unknown): { readonly id: string } {
  const row = record(op, value);
  return { id: stringField(op, row, 'id') };
}

export function parseWagerStatusRow(op: string, value: unknown): WagerStatusRow {
  const row = record(op, value);
  return {
    paused: booleanField(op, row, 'paused'),
    reason: nullableStringField(op, row, 'reason'),
    updated_at: stringField(op, row, 'updated_at'),
  };
}

export interface RawPendingStakeIntentRow {
  readonly id: string;
  readonly user_id: number;
  readonly group_id: number;
  readonly market_id: string;
  readonly side: 'back' | 'doubt';
  readonly lamports: number;
  readonly state: PendingStakeIntentState;
  readonly expires_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function parsePendingStakeIntentRow(op: string, value: unknown): RawPendingStakeIntentRow {
  const row = record(op, value);
  const side = row.side;
  if (!isPositionSide(side)) return malformed(op, 'side');
  const state = row.state;
  if (!isPendingStakeIntentState(state)) return malformed(op, 'state');
  return {
    id: stringField(op, row, 'id'),
    user_id: integerField(op, row, 'user_id'),
    group_id: integerField(op, row, 'group_id'),
    market_id: stringField(op, row, 'market_id'),
    side,
    lamports: integerField(op, row, 'lamports'),
    state,
    expires_at: stringField(op, row, 'expires_at'),
    created_at: stringField(op, row, 'created_at'),
    updated_at: stringField(op, row, 'updated_at'),
  };
}
