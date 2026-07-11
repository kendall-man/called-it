import { DbError } from './errors.js';

export type DatabaseRow = Readonly<Record<string, unknown>>;

export function record(op: string, value: unknown): DatabaseRow {
  if (isRecord(value)) return value;
  return contractFailure(op, '<row>');
}

export function exactKeys(op: string, row: DatabaseRow, allowed: readonly string[]): void {
  const keys = Object.keys(row);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowed.some((allowedKey) => allowedKey === key))
  ) {
    contractFailure(op, '<keys>');
  }
}

export function responseData(op: string, value: unknown): unknown {
  const response = record(op, value);
  if (!('data' in response) || !('error' in response)) {
    return contractFailure(op, '<response>');
  }
  if (response.error === null) return response.data;
  const error = record(op, response.error);
  if (typeof error.message !== 'string') return contractFailure(op, '<error>');
  const code = error.code;
  if (code !== undefined && typeof code !== 'string') return contractFailure(op, '<error>');
  return databaseFailure(op, code);
}

export function rows(op: string, response: unknown): readonly unknown[] {
  const data = responseData(op, response);
  if (Array.isArray(data)) return data;
  return contractFailure(op, '<rows>');
}

export function booleanField(op: string, row: DatabaseRow, field: string): boolean {
  const value = row[field];
  if (typeof value === 'boolean') return value;
  return contractFailure(op, field);
}

export function safeIntegerField(op: string, row: DatabaseRow, field: string): number {
  const value = row[field];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return contractFailure(op, field);
}

export function positiveIntegerField(op: string, row: DatabaseRow, field: string): number {
  const value = safeIntegerField(op, row, field);
  if (value > 0) return value;
  return contractFailure(op, field);
}

export function countField(op: string, row: DatabaseRow, field: string): number {
  const value = safeIntegerField(op, row, field);
  if (value >= 0) return value;
  return contractFailure(op, field);
}

export function stringField(op: string, row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value === 'string') return value;
  return contractFailure(op, field);
}

export function nullableStringField(
  op: string,
  row: DatabaseRow,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || typeof value === 'string') return value;
  return contractFailure(op, field);
}

export function positionSide(op: string, value: unknown): 'back' | 'doubt' {
  switch (value) {
    case 'back':
    case 'doubt':
      return value;
    default:
      return contractFailure(op, 'side');
  }
}

export function assertSafeInput(op: string, field: string, value: number): void {
  if (!Number.isSafeInteger(value)) contractFailure(op, field);
}

export function assertPositiveInput(op: string, field: string, value: number): void {
  assertSafeInput(op, field, value);
  if (value <= 0) contractFailure(op, field);
}

export function contractFailure(op: string, field: string): never {
  throw new DbError(op, { message: `database contract violation at ${field}` });
}

function isRecord(value: unknown): value is DatabaseRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function databaseFailure(op: string, code: string | undefined): never {
  throw new DbError(op, { message: 'database operation failed', code });
}
