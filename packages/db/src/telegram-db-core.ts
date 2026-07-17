import { DbError } from './errors.js';
import type {
  TelegramDbCode,
  TelegramOutboundState,
  TelegramRoutingDecision,
  TelegramUpdateState,
  TelegramWorkerKind,
} from './telegram-types.js';

type DatabaseRow = Readonly<Record<string, unknown>>;

export interface TelegramDbClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<import('./errors.js').PgResult<unknown>>;
}

export function requireTelegramDbClient(value: unknown): TelegramDbClient {
  if (
    typeof value === 'object' &&
    value !== null &&
    'rpc' in value &&
    typeof value.rpc === 'function'
  ) {
    return value as TelegramDbClient;
  }
  throw new DbError('createTelegramDb', { message: 'malformed Supabase client' });
}

export function record(op: string, value: unknown): DatabaseRow {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as DatabaseRow;
  }
  throw new DbError(op, { message: 'malformed RPC payload' });
}

export function stringField(op: string, row: DatabaseRow, key: string): string {
  const value = row[key];
  if (typeof value === 'string') {
    return value;
  }
  throw new DbError(op, { message: `malformed RPC payload field: ${key}` });
}

export function nullableStringField(op: string, row: DatabaseRow, key: string): string | null {
  const value = row[key];
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new DbError(op, { message: `malformed RPC payload field: ${key}` });
}

export function integerField(op: string, row: DatabaseRow, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  throw new DbError(op, { message: `malformed RPC payload field: ${key}` });
}

export function booleanField(op: string, row: DatabaseRow, key: string): boolean {
  const value = row[key];
  if (typeof value === 'boolean') {
    return value;
  }
  throw new DbError(op, { message: `malformed RPC payload field: ${key}` });
}

export function objectField(op: string, row: DatabaseRow, key: string): DatabaseRow {
  const value = row[key];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as DatabaseRow;
  }
  throw new DbError(op, { message: `malformed RPC payload field: ${key}` });
}

export function arrayField(op: string, row: DatabaseRow, key: string): readonly unknown[] {
  const value = row[key];
  if (Array.isArray(value)) {
    return value;
  }
  throw new DbError(op, { message: `malformed RPC payload field: ${key}` });
}

export function isTelegramDbCode(value: unknown): value is TelegramDbCode {
  return (
    value === 'invalid_input' ||
    value === 'source_conflict' ||
    value === 'logical_key_conflict' ||
    value === 'not_due' ||
    value === 'lease_lost' ||
    value === 'terminal_state' ||
    value === 'ownership_conflict' ||
    value === 'not_found'
  );
}

export function isRoutingDecision(value: unknown): value is TelegramRoutingDecision {
  return value === 'pending_engine' || value === 'routed_concierge';
}

export function isUpdateState(value: unknown): value is TelegramUpdateState {
  return (
    value === 'pending_engine' ||
    value === 'routed_concierge' ||
    value === 'leased' ||
    value === 'retry_wait' ||
    value === 'completed' ||
    value === 'dead'
  );
}

export function isOutboundState(value: unknown): value is TelegramOutboundState {
  return (
    value === 'planned' ||
    value === 'sending' ||
    value === 'owned' ||
    value === 'complete' ||
    value === 'ownership_uncertain' ||
    value === 'reconciled' ||
    value === 'manual_review'
  );
}

export function isWorkerKind(value: unknown): value is TelegramWorkerKind {
  return (
    value === 'telegram_ingress' ||
    value === 'telegram_outbound' ||
    value === 'telegram_ownership_reconciler'
  );
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
