import { DbError, type PgResult } from './errors.js';
import type { EscrowDbClient } from './escrow-db.js';
import type {
  ConfigureEscrowGroupRolloutInput,
  ConfigureEscrowGroupRolloutResult,
  EnqueueEscrowAttestationRequestInput,
  EscrowAttestationEnqueueResult,
  EscrowAttestationLeaseTransitionInput,
  EscrowAttestationMutationResult,
  EscrowAttestationOperationKind,
  EscrowAttestationRequestRow,
  EscrowAttestationState,
  EscrowGroupRolloutRow,
  EscrowMarketClosedInput,
  EscrowReleaseBlockersDb,
  GetEscrowGroupRolloutInput,
  GetEscrowGroupRolloutResult,
  LeaseEscrowAttestationRequestsInput,
  MarkEscrowAttestationEnqueuedInput,
  RecordEscrowAttestationSignedInput,
  RetryEscrowAttestationRequestInput,
} from './escrow-release-blockers-types.js';
import type { EscrowCluster, EscrowIndexResult } from './escrow-types.js';

export function escrowReleaseBlockersDbFromClient(
  client: EscrowDbClient,
): EscrowReleaseBlockersDb {
  return {
    configureGroupRollout(input) {
      validateConfigureGroupRollout(input);
      return rpc(client, 'escrow_configure_group_rollout', {
        p_group_id: input.groupId,
        p_custody_mode: input.custodyMode,
        p_cluster: input.cluster,
        p_genesis_hash: input.genesisHash,
        p_program_id: input.programId,
        p_custody_version: input.custodyVersion,
        p_enabled_by: input.enabledBy,
        p_now: input.nowIso,
      }, parseConfigureGroupRollout);
    },

    getGroupRollout(input) {
      validateGetGroupRollout(input);
      return rpc(client, 'escrow_get_group_rollout', {
        p_group_id: input.groupId,
      }, parseGetGroupRollout);
    },

    recordMarketClosed(input) {
      validateMarketClosed(input);
      return rpc(client, 'escrow_index_market_closed', {
        p_signature: input.signature,
        p_instruction_index: input.instructionIndex,
        p_market_id: input.marketId,
        p_cluster: input.cluster,
        p_genesis_hash: input.genesisHash,
        p_program_id: input.programId,
        p_market_pda: input.marketPda,
        p_document_hash_hex: input.documentHashHex,
        p_asset: input.asset,
        p_dust_amount_atomic: decimal(input.dustAmountAtomic, 'dustAmountAtomic'),
        p_slot: decimal(input.slot, 'slot'),
        p_block_time: input.blockTimeIso,
        p_commitment: input.commitment,
        p_observed_at: input.observedAtIso,
      }, parseIndexResult);
    },

    enqueueAttestationRequest(input) {
      validateEnqueue(input);
      return rpc(client, 'escrow_attestation_enqueue', {
        p_request_key: input.requestKey,
        p_operation_kind: input.operationKind,
        p_cluster: input.cluster,
        p_genesis_hash: input.genesisHash,
        p_program_id: input.programId,
        p_custody_version: input.custodyVersion,
        p_market_id: input.marketId,
        p_market_pda: input.marketPda,
        p_document_hash_hex: input.documentHashHex,
        p_oracle_epoch: decimal(input.oracleEpoch, 'oracleEpoch'),
        p_event_epoch: decimal(input.eventEpoch, 'eventEpoch'),
        p_unsigned_payload: input.unsignedPayload,
        p_unsigned_payload_hash_hex: input.unsignedPayloadHashHex,
        p_due_at: input.dueAtIso,
        p_debounce_until: input.debounceUntilIso,
        p_max_attempts: input.maxAttempts,
        p_lease_ms: input.leaseMs ?? 60_000,
        p_now: input.nowIso,
      }, parseEnqueueResult);
    },

    leaseAttestationRequests(input) {
      validateLease(input);
      return rpc(client, 'escrow_attestation_lease', {
        p_worker_id: input.workerId,
        p_now: input.nowIso,
        p_limit: input.limit,
      }, parseRequestRows);
    },

    recordAttestationSigned(input) {
      validateSigned(input);
      return rpc(client, 'escrow_attestation_record_signed', {
        ...leaseArgs(input),
        p_signed_payload: input.signedPayload,
        p_signed_payload_hash_hex: input.signedPayloadHashHex,
      }, parseMutationResult);
    },

    markAttestationEnqueued(input) {
      validateMarkEnqueued(input);
      return rpc(client, 'escrow_attestation_mark_enqueued', {
        ...leaseArgs(input),
        p_relayer_job_id: input.relayerJobId,
        p_next_check_at: input.nextCheckAtIso,
      }, parseMutationResult);
    },

    completeAttestationRequest(input) {
      validateLeaseTransition(input);
      return rpc(
        client,
        'escrow_attestation_complete',
        leaseArgs(input),
        parseMutationResult,
      );
    },

    retryAttestationRequest(input) {
      validateRetry(input);
      return rpc(client, 'escrow_attestation_retry', {
        ...leaseArgs(input),
        p_error_code: input.errorCode,
        p_retry_at: input.retryAtIso,
      }, parseMutationResult);
    },
  };
}

async function rpc<T>(
  client: EscrowDbClient,
  operation: string,
  args: Record<string, unknown>,
  parse: (operation: string, value: unknown) => T,
): Promise<T> {
  const result: PgResult<unknown> = await client.rpc(operation, args);
  if (result.error !== null || result.data === null) {
    throw new DbError(operation, result.error ?? { message: 'no RPC payload returned' });
  }
  return parse(operation, result.data);
}

type Row = Readonly<Record<string, unknown>>;

function parseConfigureGroupRollout(
  operation: string,
  value: unknown,
): ConfigureEscrowGroupRolloutResult {
  const valueRow = row(operation, value);
  if (valueRow.ok !== true) return malformed(operation, 'ok');
  return {
    ok: true,
    created: bool(operation, valueRow.created, 'created'),
    ...parseGroupRolloutRow(operation, valueRow),
  };
}

function parseGetGroupRollout(
  operation: string,
  value: unknown,
): GetEscrowGroupRolloutResult {
  const valueRow = row(operation, value);
  if (valueRow.ok !== true) return malformed(operation, 'ok');
  const found = bool(operation, valueRow.found, 'found');
  if (!found) return { ok: true, found: false };
  return { ok: true, found: true, ...parseGroupRolloutRow(operation, valueRow) };
}

function parseGroupRolloutRow(
  operation: string,
  valueRow: Row,
): EscrowGroupRolloutRow {
  const custodyMode = rolloutCustodyMode(operation, valueRow.custody_mode);
  const cluster = nullableCluster(operation, valueRow.cluster);
  const genesisHash = nullableBoundedString(operation, valueRow.genesis_hash, 'genesis_hash');
  const programId = nullableBoundedString(operation, valueRow.program_id, 'program_id');
  const custodyVersion = nullableInteger(operation, valueRow.custody_version, 'custody_version');
  if (
    (custodyMode === 'legacy' && (
      cluster !== null || genesisHash !== null || programId !== null || custodyVersion !== null
    ))
    || (custodyMode === 'escrow' && (
      cluster === null || genesisHash === null || programId === null
      || custodyVersion === null || custodyVersion < 1
    ))
  ) return malformed(operation, 'rollout_binding');
  return {
    groupId: integer(operation, valueRow.group_id, 'group_id'),
    custodyMode,
    cluster,
    genesisHash,
    programId,
    custodyVersion,
    enabledBy: nullableInteger(operation, valueRow.enabled_by, 'enabled_by'),
    updatedAtIso: timestampValue(operation, valueRow.updated_at, 'updated_at'),
  };
}

function parseIndexResult(operation: string, value: unknown): EscrowIndexResult {
  const valueRow = row(operation, value);
  if (valueRow.ok !== true) return malformed(operation, 'ok');
  return {
    ok: true,
    duplicate: bool(operation, valueRow.duplicate, 'duplicate'),
    finalized: bool(operation, valueRow.finalized, 'finalized'),
  };
}

function parseEnqueueResult(
  operation: string,
  value: unknown,
): EscrowAttestationEnqueueResult {
  const valueRow = row(operation, value);
  if (valueRow.ok !== true) return malformed(operation, 'ok');
  return {
    ok: true,
    created: bool(operation, valueRow.created, 'created'),
    requestKey: hashValue(operation, valueRow.request_key, 'request_key'),
  };
}

function parseMutationResult(
  operation: string,
  value: unknown,
): EscrowAttestationMutationResult {
  const valueRow = row(operation, value);
  if (valueRow.ok === true) {
    return {
      ok: true,
      duplicate: bool(operation, valueRow.duplicate, 'duplicate'),
      state: stateValue(operation, valueRow.state),
    };
  }
  if (valueRow.ok === false) {
    switch (valueRow.code) {
      case 'request_not_found':
      case 'lease_lost':
      case 'state_conflict':
      case 'payload_mismatch':
      case 'relayer_mismatch':
        return { ok: false, code: valueRow.code };
      default:
        return malformed(operation, 'code');
    }
  }
  return malformed(operation, 'ok');
}

function parseRequestRows(
  operation: string,
  value: unknown,
): readonly EscrowAttestationRequestRow[] {
  if (!Array.isArray(value)) return malformed(operation, '<rows>');
  return value.map((item) => {
    const valueRow = row(operation, item);
    return {
      requestKey: hashValue(operation, valueRow.request_key, 'request_key'),
      operationKind: operationKindValue(operation, valueRow.operation_kind),
      state: stateValue(operation, valueRow.state),
      cluster: clusterValue(operation, valueRow.cluster),
      genesisHash: boundedString(operation, valueRow.genesis_hash, 'genesis_hash'),
      programId: boundedString(operation, valueRow.program_id, 'program_id'),
      custodyVersion: integer(operation, valueRow.custody_version, 'custody_version'),
      marketId: uuidValue(operation, valueRow.market_id, 'market_id'),
      marketPda: boundedString(operation, valueRow.market_pda, 'market_pda'),
      documentHashHex: hashValue(operation, valueRow.document_hash_hex, 'document_hash_hex'),
      oracleEpoch: bigintValue(operation, valueRow.oracle_epoch, 'oracle_epoch'),
      eventEpoch: bigintValue(operation, valueRow.event_epoch, 'event_epoch'),
      unsignedPayload: object(operation, valueRow.unsigned_payload, 'unsigned_payload'),
      unsignedPayloadHashHex: hashValue(
        operation,
        valueRow.unsigned_payload_hash_hex,
        'unsigned_payload_hash_hex',
      ),
      signedPayload: nullableObject(operation, valueRow.signed_payload, 'signed_payload'),
      signedPayloadHashHex: nullableHash(
        operation,
        valueRow.signed_payload_hash_hex,
        'signed_payload_hash_hex',
      ),
      dueAtIso: timestampValue(operation, valueRow.due_at, 'due_at'),
      debounceUntilIso: timestampValue(
        operation,
        valueRow.debounce_until,
        'debounce_until',
      ),
      relayerJobId: nullableUuid(operation, valueRow.relayer_job_id, 'relayer_job_id'),
      attempts: integer(operation, valueRow.attempts, 'attempts'),
      maxAttempts: integer(operation, valueRow.max_attempts, 'max_attempts'),
      leaseDurationMs: integer(
        operation,
        valueRow.lease_duration_ms,
        'lease_duration_ms',
      ),
      leaseOwner: nullableString(operation, valueRow.lease_owner, 'lease_owner'),
      leaseToken: nullableUuid(operation, valueRow.lease_token, 'lease_token'),
      leaseExpiresAtIso: nullableTimestamp(
        operation,
        valueRow.lease_expires_at,
        'lease_expires_at',
      ),
      errorCode: nullableString(operation, valueRow.error_code, 'error_code'),
      createdAtIso: timestampValue(operation, valueRow.created_at, 'created_at'),
      updatedAtIso: timestampValue(operation, valueRow.updated_at, 'updated_at'),
      signedAtIso: nullableTimestamp(operation, valueRow.signed_at, 'signed_at'),
      enqueuedAtIso: nullableTimestamp(operation, valueRow.enqueued_at, 'enqueued_at'),
      completedAtIso: nullableTimestamp(operation, valueRow.completed_at, 'completed_at'),
      failedAtIso: nullableTimestamp(operation, valueRow.failed_at, 'failed_at'),
    };
  });
}

function validateMarketClosed(input: EscrowMarketClosedInput): void {
  nonempty(input.signature, 'signature');
  safeInteger(input.instructionIndex, 'instructionIndex');
  uuidInput(input.marketId, 'marketId');
  clusterInput(input.cluster, 'cluster');
  boundedNonempty(input.genesisHash, 'genesisHash');
  boundedNonempty(input.programId, 'programId');
  boundedNonempty(input.marketPda, 'marketPda');
  hashInput(input.documentHashHex, 'documentHashHex');
  if (input.asset !== 'sol' && input.asset !== 'usdc') invalid('asset');
  decimal(input.dustAmountAtomic, 'dustAmountAtomic');
  decimal(input.slot, 'slot');
  optionalTimestamp(input.blockTimeIso, 'blockTimeIso');
  if (input.commitment !== 'finalized') invalid('commitment');
  timestampInput(input.observedAtIso, 'observedAtIso');
}

function validateConfigureGroupRollout(input: ConfigureEscrowGroupRolloutInput): void {
  safeInteger(input.groupId, 'groupId', true);
  if (input.enabledBy !== null) safeInteger(input.enabledBy, 'enabledBy', true);
  timestampInput(input.nowIso, 'nowIso');
  if (input.custodyMode === 'legacy') {
    if (
      input.cluster !== null
      || input.genesisHash !== null
      || input.programId !== null
      || input.custodyVersion !== null
    ) invalid('rolloutBinding');
    return;
  }
  clusterInput(input.cluster, 'cluster');
  boundedNonempty(input.genesisHash, 'genesisHash');
  boundedNonempty(input.programId, 'programId');
  safeInteger(input.custodyVersion, 'custodyVersion', true);
}

function validateGetGroupRollout(input: GetEscrowGroupRolloutInput): void {
  safeInteger(input.groupId, 'groupId', true);
}

function validateEnqueue(input: EnqueueEscrowAttestationRequestInput): void {
  hashInput(input.requestKey, 'requestKey');
  operationKindInput(input.operationKind, 'operationKind');
  clusterInput(input.cluster, 'cluster');
  boundedNonempty(input.genesisHash, 'genesisHash');
  boundedNonempty(input.programId, 'programId');
  safeInteger(input.custodyVersion, 'custodyVersion', true);
  uuidInput(input.marketId, 'marketId');
  boundedNonempty(input.marketPda, 'marketPda');
  hashInput(input.documentHashHex, 'documentHashHex');
  decimal(input.oracleEpoch, 'oracleEpoch');
  decimal(input.eventEpoch, 'eventEpoch');
  safePayload(input.unsignedPayload, 'unsignedPayload');
  hashInput(input.unsignedPayloadHashHex, 'unsignedPayloadHashHex');
  timestampInput(input.dueAtIso, 'dueAtIso');
  if (input.debounceUntilIso !== null) {
    timestampInput(input.debounceUntilIso, 'debounceUntilIso');
  }
  safeInteger(input.maxAttempts, 'maxAttempts', true);
  safeInteger(input.leaseMs ?? 60_000, 'leaseMs', true);
  if ((input.leaseMs ?? 60_000) > 600_000) invalid('leaseMs');
  timestampInput(input.nowIso, 'nowIso');
}

function validateLease(input: LeaseEscrowAttestationRequestsInput): void {
  boundedNonempty(input.workerId, 'workerId');
  timestampInput(input.nowIso, 'nowIso');
  safeInteger(input.limit, 'limit', true);
  if (input.limit > 100) invalid('limit');
}

function validateLeaseTransition(input: EscrowAttestationLeaseTransitionInput): void {
  hashInput(input.requestKey, 'requestKey');
  boundedNonempty(input.workerId, 'workerId');
  uuidInput(input.leaseToken, 'leaseToken');
  timestampInput(input.nowIso, 'nowIso');
}

function validateSigned(input: RecordEscrowAttestationSignedInput): void {
  validateLeaseTransition(input);
  safePayload(input.signedPayload, 'signedPayload');
  hashInput(input.signedPayloadHashHex, 'signedPayloadHashHex');
}

function validateMarkEnqueued(input: MarkEscrowAttestationEnqueuedInput): void {
  validateLeaseTransition(input);
  uuidInput(input.relayerJobId, 'relayerJobId');
  timestampInput(input.nextCheckAtIso, 'nextCheckAtIso');
}

function validateRetry(input: RetryEscrowAttestationRequestInput): void {
  validateLeaseTransition(input);
  boundedNonempty(input.errorCode, 'errorCode');
  timestampInput(input.retryAtIso, 'retryAtIso');
}

function leaseArgs(input: EscrowAttestationLeaseTransitionInput): Record<string, unknown> {
  return {
    p_request_key: input.requestKey,
    p_worker_id: input.workerId,
    p_lease_token: input.leaseToken,
    p_now: input.nowIso,
  };
}

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'secret',
  'secretkey',
  'privatekey',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'signingtoken',
  'bearertoken',
  'rawprivateevidence',
  'mnemonic',
  'seedphrase',
  'password',
]);

function safePayload(value: Readonly<Record<string, unknown>>, field: string): void {
  if (!isJsonObject(value) || !safeJsonNode(value)) invalid(field);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return invalid(field);
  }
  if (Buffer.byteLength(encoded, 'utf8') > 65_536) invalid(field);
}

function safeJsonNode(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(safeJsonNode);
  if (!isJsonObject(value)) return false;
  return Object.entries(value).every(([key, child]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return !FORBIDDEN_PAYLOAD_KEYS.has(normalizedKey) && safeJsonNode(child);
  });
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function row(operation: string, value: unknown): Row {
  if (isJsonObject(value)) return value;
  return malformed(operation, '<row>');
}

function object(
  operation: string,
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (isJsonObject(value)) return value;
  return malformed(operation, field);
}

function nullableObject(
  operation: string,
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  return object(operation, value, field);
}

function stringValue(operation: string, value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  return malformed(operation, field);
}

function boundedString(operation: string, value: unknown, field: string): string {
  const parsed = stringValue(operation, value, field);
  if (parsed.length <= 128) return parsed;
  return malformed(operation, field);
}

function nullableString(operation: string, value: unknown, field: string): string | null {
  if (value === null) return null;
  return stringValue(operation, value, field);
}

function nullableBoundedString(operation: string, value: unknown, field: string): string | null {
  if (value === null) return null;
  return boundedString(operation, value, field);
}

function bool(operation: string, value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  return malformed(operation, field);
}

function integer(operation: string, value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return malformed(operation, field);
}

function nullableInteger(operation: string, value: unknown, field: string): number | null {
  if (value === null) return null;
  return integer(operation, value, field);
}

function bigintValue(operation: string, value: unknown, field: string): bigint {
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return malformed(operation, field);
}

function uuidValue(operation: string, value: unknown, field: string): string {
  const parsed = stringValue(operation, value, field);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed)) {
    return parsed;
  }
  return malformed(operation, field);
}

function nullableUuid(operation: string, value: unknown, field: string): string | null {
  if (value === null) return null;
  return uuidValue(operation, value, field);
}

function hashValue(operation: string, value: unknown, field: string): string {
  const parsed = stringValue(operation, value, field);
  if (/^[0-9a-f]{64}$/i.test(parsed)) return parsed.toLowerCase();
  return malformed(operation, field);
}

function nullableHash(operation: string, value: unknown, field: string): string | null {
  if (value === null) return null;
  return hashValue(operation, value, field);
}

function timestampValue(operation: string, value: unknown, field: string): string {
  const parsed = stringValue(operation, value, field);
  if (isTimestamp(parsed)) return parsed;
  return malformed(operation, field);
}

function nullableTimestamp(operation: string, value: unknown, field: string): string | null {
  if (value === null) return null;
  return timestampValue(operation, value, field);
}

function clusterValue(operation: string, value: unknown): EscrowCluster {
  if (value === 'localnet' || value === 'devnet' || value === 'mainnet-beta') return value;
  return malformed(operation, 'cluster');
}

function nullableCluster(operation: string, value: unknown): EscrowCluster | null {
  if (value === null) return null;
  return clusterValue(operation, value);
}

function rolloutCustodyMode(operation: string, value: unknown): 'legacy' | 'escrow' {
  if (value === 'legacy' || value === 'escrow') return value;
  return malformed(operation, 'custody_mode');
}

function operationKindValue(operation: string, value: unknown): EscrowAttestationOperationKind {
  if (
    value === 'freeze'
    || value === 'unfreeze'
    || value === 'invalidate'
    || value === 'settle'
    || value === 'void'
  ) return value;
  return malformed(operation, 'operation_kind');
}

function stateValue(operation: string, value: unknown): EscrowAttestationState {
  if (
    value === 'pending'
    || value === 'leased'
    || value === 'signed'
    || value === 'enqueued'
    || value === 'completed'
    || value === 'failed'
  ) return value;
  return malformed(operation, 'state');
}

function malformed(operation: string, field: string): never {
  throw new DbError(operation, { message: `malformed RPC payload field: ${field}` });
}

function invalid(field: string): never {
  throw new DbError('escrowInput', { message: `invalid ${field}` });
}

function decimal(value: bigint, field: string): string {
  if (typeof value !== 'bigint' || value < 0n) invalid(field);
  return value.toString(10);
}

function safeInteger(value: number, field: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) invalid(field);
}

function nonempty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') invalid(field);
}

function boundedNonempty(value: string, field: string): void {
  nonempty(value, field);
  if (value.length > 128) invalid(field);
}

function uuidInput(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    invalid(field);
  }
}

function hashInput(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) invalid(field);
}

function clusterInput(value: EscrowCluster, field: string): void {
  if (value !== 'localnet' && value !== 'devnet' && value !== 'mainnet-beta') invalid(field);
}

function operationKindInput(value: EscrowAttestationOperationKind, field: string): void {
  if (
    value !== 'freeze'
    && value !== 'unfreeze'
    && value !== 'invalidate'
    && value !== 'settle'
    && value !== 'void'
  ) invalid(field);
}

function timestampInput(value: string, field: string): void {
  if (!isTimestamp(value)) invalid(field);
}

function optionalTimestamp(value: string | null, field: string): void {
  if (value !== null) timestampInput(value, field);
}

function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
