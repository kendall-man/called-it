import { DbError } from './errors.js';
import type {
  GetProofSubmissionResult,
  PrepareProofSubmissionInput,
  ProofSubmissionIdentity,
  ProofSubmissionMutationResult,
  ProofSubmissionOutboxRow,
  ProofSubmissionOutboxRpcCode,
  ProofSubmissionOutboxState,
} from './proof-submission-outbox-types.js';

export function parseGetProofSubmission(op: string, payload: unknown): GetProofSubmissionResult {
  const row = record(op, payload);
  if (row.ok === false) return { ok: false, code: code(op, row.code) };
  if (row.ok !== true) invalid(op, 'ok');
  return { ok: true, outbox: row.outbox === null ? null : parseProofSubmissionRow(op, row.outbox) };
}

export function parseProofSubmissionMutation(
  op: string,
  payload: unknown,
): ProofSubmissionMutationResult {
  const row = record(op, payload);
  if (row.ok === false) return { ok: false, code: code(op, row.code) };
  if (row.ok !== true) invalid(op, 'ok');
  return {
    ok: true,
    duplicate: booleanField(op, row, 'duplicate'),
    outbox: parseProofSubmissionRow(op, row.outbox),
  };
}

export function validatePrepareProofSubmission(input: PrepareProofSubmissionInput): void {
  requireUuid('proof_submission_prepare.marketId', input.marketId);
  requireTimestamp('proof_submission_prepare.nowIso', input.nowIso);
  requireBounded('proof_submission_prepare.signature', input.signature, 32, 128);
  requireBounded('proof_submission_prepare.rawTxB64', input.rawTxB64, 8, 16_384);
  requirePositiveInteger('proof_submission_prepare.lastValidBlockHeight', input.lastValidBlockHeight);
  if (!isRecord(input.proofPayload)) invalid('proof_submission_prepare', 'proofPayload');
}

export function validateProofSubmissionIdentity(op: string, input: ProofSubmissionIdentity): void {
  requireUuid(`${op}.marketId`, input.marketId);
  requirePositiveInteger(`${op}.attempt`, input.attempt);
  requireBounded(`${op}.signature`, input.signature, 32, 128);
  requireTimestamp(`${op}.nowIso`, input.nowIso);
}

function parseProofSubmissionRow(op: string, payload: unknown): ProofSubmissionOutboxRow {
  const row = record(op, payload);
  const state = stateField(op, row.state);
  const attempt = positiveInteger(op, row, 'attempt');
  const broadcastCount = integer(op, row, 'broadcast_count');
  const lastValidBlockHeight = positiveInteger(op, row, 'last_valid_block_height');
  const preparedAt = timestamp(op, stringField(op, row, 'prepared_at'), 'prepared_at');
  const lastBroadcastAt = nullableTimestamp(op, row, 'last_broadcast_at');
  const landedAt = nullableTimestamp(op, row, 'landed_at');
  const expiredAt = nullableTimestamp(op, row, 'expired_at');
  const updatedAt = timestamp(op, stringField(op, row, 'updated_at'), 'updated_at');
  const proofPayload = record(op, row.proof_payload);
  const signature = boundedString(op, row, 'signature', 32, 128);
  const rawTxB64 = boundedString(op, row, 'raw_tx_b64', 8, 16_384);
  if (broadcastCount < 0 || Date.parse(updatedAt) < Date.parse(preparedAt)) invalid(op, 'outbox_shape');
  assertStateShape(op, state, broadcastCount, lastBroadcastAt, landedAt, expiredAt);
  return {
    marketId: uuid(op, stringField(op, row, 'market_id'), 'market_id'),
    attempt,
    state,
    signature,
    rawTxB64,
    lastValidBlockHeight,
    proofPayload,
    broadcastCount,
    preparedAt,
    lastBroadcastAt,
    landedAt,
    expiredAt,
    updatedAt,
  };
}

function assertStateShape(
  op: string,
  state: ProofSubmissionOutboxState,
  broadcastCount: number,
  lastBroadcastAt: string | null,
  landedAt: string | null,
  expiredAt: string | null,
): void {
  switch (state) {
    case 'prepared':
      if (broadcastCount === 0 && lastBroadcastAt === null && landedAt === null && expiredAt === null) return;
      return invalid(op, 'prepared_shape');
    case 'broadcast':
      if (broadcastCount >= 1 && lastBroadcastAt !== null && landedAt === null && expiredAt === null) return;
      return invalid(op, 'broadcast_shape');
    case 'landed':
      if (landedAt !== null && expiredAt === null) return;
      return invalid(op, 'landed_shape');
    case 'expired':
      if (landedAt === null && expiredAt !== null) return;
      return invalid(op, 'expired_shape');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(op: string, value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) return value;
  return invalid(op, 'row');
}

function booleanField(op: string, row: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = row[field];
  if (typeof value === 'boolean') return value;
  return invalid(op, field);
}

function stringField(op: string, row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value === 'string') return value;
  return invalid(op, field);
}

function boundedString(op: string, row: Readonly<Record<string, unknown>>, field: string, min: number, max: number): string {
  return bounded(op, stringField(op, row, field), min, max);
}

function bounded(op: string, value: string, min: number, max: number): string {
  if (value.length >= min && value.length <= max && value.trim() !== '') return value;
  return invalid(op, 'bounded_string');
}

function integer(op: string, row: Readonly<Record<string, unknown>>, field: string): number {
  const value = row[field];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return invalid(op, field);
}

function positiveInteger(op: string, row: Readonly<Record<string, unknown>>, field: string): number {
  const value = integer(op, row, field);
  if (value > 0) return value;
  return invalid(op, field);
}

function stateField(op: string, value: unknown): ProofSubmissionOutboxState {
  switch (value) {
    case 'prepared':
    case 'broadcast':
    case 'landed':
    case 'expired':
      return value;
    default:
      return invalid(op, 'state');
  }
}

function code(op: string, value: unknown): ProofSubmissionOutboxRpcCode {
  switch (value) {
    case 'market_not_found':
    case 'proof_not_pending':
    case 'submission_not_found':
    case 'submission_identity_conflict':
    case 'submission_not_active':
      return value;
    default:
      return invalid(op, 'code');
  }
}

function uuid(op: string, value: string, field: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
  return invalid(op, field);
}

function timestamp(op: string, value: string, field: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) return value;
  return invalid(op, field);
}

function nullableTimestamp(op: string, row: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value === 'string') return timestamp(op, value, field);
  return invalid(op, field);
}

function requireUuid(op: string, value: string): void {
  uuid(op, value, 'uuid');
}

function requireTimestamp(op: string, value: string): void {
  timestamp(op, value, 'timestamp');
}

function requireBounded(op: string, value: string, min: number, max: number): void {
  bounded(op, value, min, max);
}

function requirePositiveInteger(op: string, value: number): void {
  if (Number.isSafeInteger(value) && value > 0) return;
  invalid(op, 'positive_integer');
}

function invalid(op: string, field: string): never {
  throw new DbError(op, { message: `malformed proof submission payload: ${field}` });
}
