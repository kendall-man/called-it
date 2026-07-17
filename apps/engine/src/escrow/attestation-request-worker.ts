import { bytesToHex } from '@calledit/escrow-sdk';
import { base58Decode } from '@calledit/solana';
import type {
  EscrowAttestationLeaseTransitionInput,
  EscrowAttestationMutationResult,
  EscrowAttestationRequestRow as DatabaseAttestationRequestRow,
  LeaseEscrowAttestationRequestsInput,
  MarkEscrowAttestationEnqueuedInput,
  RecordEscrowAttestationSignedInput,
  RetryEscrowAttestationRequestInput,
} from '@calledit/db';
import type { EscrowOracleAttestationProvider } from './attestation-signers.js';
import type { EscrowControlRequest } from './control-workflows.js';
import {
  attestationPayloadHash,
  attestationSigningRequest,
  createSignedAttestationPayload,
  parseSignedAttestationPayload,
  parseUnsignedAttestationPayload,
  restoreSignedWorkflowRequest,
  type EscrowUnsignedAttestationPayload,
} from './attestation-request-payload.js';
import { attestationRequestKey } from './attestation-request-service.js';
import type { EscrowRecoveryRequest } from './recovery-workflows.js';

export type EscrowAttestationRequestRow = DatabaseAttestationRequestRow;
type TransitionResult = EscrowAttestationMutationResult;

export interface EscrowAttestationWorkerDatabase {
  leaseAttestationRequests(input: LeaseEscrowAttestationRequestsInput): Promise<readonly EscrowAttestationRequestRow[]>;
  recordAttestationSigned(input: RecordEscrowAttestationSignedInput): Promise<TransitionResult>;
  markAttestationEnqueued(input: MarkEscrowAttestationEnqueuedInput): Promise<TransitionResult>;
  completeAttestationRequest(input: EscrowAttestationLeaseTransitionInput): Promise<TransitionResult>;
  retryAttestationRequest(input: RetryEscrowAttestationRequestInput): Promise<TransitionResult>;
}

interface QueueResult {
  readonly kind: 'blocked' | 'enqueued';
  readonly jobId?: string;
}

export type EscrowAttestationWorkerResult =
  | { readonly kind: 'completed'; readonly requestKey: string; readonly relayerJobId: string | null }
  | { readonly kind: 'enqueued'; readonly requestKey: string; readonly relayerJobId: string }
  | { readonly kind: 'retrying'; readonly requestKey: string; readonly errorCode: string };

export class EscrowAttestationWorkerError extends Error {
  readonly name = 'EscrowAttestationWorkerError';
  constructor(readonly code: 'invalid_payload' | 'transition_rejected' | 'enqueue_rejected') {
    super(`escrow attestation worker rejected: ${code}`);
  }
}

function requireTransition(result: TransitionResult): asserts result is Extract<TransitionResult, { readonly ok: true }> {
  if (!result.ok) throw new EscrowAttestationWorkerError('transition_rejected');
}

function lease(row: EscrowAttestationRequestRow, nowIso: string) {
  if (row.state !== 'leased' || row.leaseOwner === null || row.leaseOwner.length === 0 ||
      row.leaseToken === null || row.leaseToken.length === 0) {
    throw new EscrowAttestationWorkerError('invalid_payload');
  }
  return { requestKey: row.requestKey, workerId: row.leaseOwner, leaseToken: row.leaseToken, nowIso };
}

function requirePayload(row: EscrowAttestationRequestRow): EscrowUnsignedAttestationPayload {
  const payload = parseUnsignedAttestationPayload(row.unsignedPayload);
  const signingRequest = attestationSigningRequest(payload);
  const attestation = signingRequest.attestation;
  const requestKeyMatches = attestationRequestKey(row.unsignedPayloadHashHex) === row.requestKey;
  if (
    // Legacy rows were hashed before the JSONB key-order fix. Their request
    // key remains the durable identity; all signed attestation fields below
    // are still checked against the row's deployment and market bindings.
    !requestKeyMatches || payload.marketId !== row.marketId ||
    payload.marketPda !== row.marketPda || payload.documentHashHex !== row.documentHashHex.toLowerCase() ||
    BigInt(payload.oracleEpoch) !== row.oracleEpoch || BigInt(payload.eventEpoch) !== row.eventEpoch ||
    bytesToHex(attestation.clusterGenesisHash) !== bytesToHex(base58Decode(row.genesisHash)) ||
    bytesToHex(attestation.escrowProgramId) !== bytesToHex(base58Decode(row.programId)) ||
    bytesToHex(attestation.marketPda) !== bytesToHex(base58Decode(row.marketPda)) ||
    bytesToHex(attestation.marketDocumentHash) !== row.documentHashHex.toLowerCase() ||
    attestation.oracleSetEpoch !== row.oracleEpoch
  ) throw new EscrowAttestationWorkerError('invalid_payload');
  return payload;
}

function errorCode(error: Error): string {
  if ('code' in error && typeof error.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code)) return error.code;
  return 'attestation_processing_failed';
}

export function createEscrowAttestationRequestWorker(options: {
  readonly db: EscrowAttestationWorkerDatabase;
  readonly oracle: EscrowOracleAttestationProvider;
  readonly control: { enqueue(request: EscrowControlRequest): Promise<QueueResult> };
  readonly recovery: { enqueue(request: EscrowRecoveryRequest): Promise<QueueResult> };
  readonly workerId: string;
  readonly retryAt: (nowIso: string) => string;
  readonly nextCheckAt: (nowIso: string) => string;
  readonly validate?: (
    row: EscrowAttestationRequestRow,
    payload: EscrowUnsignedAttestationPayload,
  ) => Promise<'current' | 'obsolete'>;
}) {
  async function retry(row: EscrowAttestationRequestRow, nowIso: string, code: string) {
    requireTransition(await options.db.retryAttestationRequest({
      ...lease(row, nowIso), errorCode: code, retryAtIso: options.retryAt(nowIso),
    }));
    return { kind: 'retrying' as const, requestKey: row.requestKey, errorCode: code };
  }

  async function complete(row: EscrowAttestationRequestRow, nowIso: string, relayerJobId: string | null) {
    const result = await options.db.completeAttestationRequest(lease(row, nowIso));
    if (!result.ok) {
      if (result.code === 'relayer_mismatch') {
        return retry(row, nowIso, 'relayer_not_complete_or_mismatch');
      }
      throw new EscrowAttestationWorkerError('transition_rejected');
    }
    return { kind: 'completed' as const, requestKey: row.requestKey, relayerJobId };
  }

  async function process(row: EscrowAttestationRequestRow, nowIso: string): Promise<EscrowAttestationWorkerResult> {
    try {
      const payload = requirePayload(row);
      if (row.relayerJobId !== null) return complete(row, nowIso, row.relayerJobId);
      if (await options.validate?.(row, payload) === 'obsolete') {
        return retry(row, nowIso, 'attestation_request_obsolete');
      }
      let signed = row.signedPayload === null
        ? null
        : parseSignedAttestationPayload(row.signedPayload, row.unsignedPayloadHashHex);
      if (signed !== null && attestationPayloadHash(signed) !== row.signedPayloadHashHex) {
        throw new EscrowAttestationWorkerError('invalid_payload');
      }
      if (signed === null) {
        if (row.signedPayloadHashHex !== null) throw new EscrowAttestationWorkerError('invalid_payload');
        const signatures = await options.oracle.sign(attestationSigningRequest(payload), {
          oracleSetEpoch: BigInt(payload.oraclePolicy.oracleSetEpoch),
          signers: payload.oraclePolicy.signers, threshold: payload.oraclePolicy.threshold,
        });
        signed = createSignedAttestationPayload(row.unsignedPayloadHashHex, signatures);
        requireTransition(await options.db.recordAttestationSigned({
          ...lease(row, nowIso), signedPayload: signed,
          signedPayloadHashHex: attestationPayloadHash(signed),
        }));
      }
      const request = restoreSignedWorkflowRequest(payload, signed);
      let queue: QueueResult;
      switch (request.operation) {
        case 'settle_market':
        case 'void_market':
          queue = await options.recovery.enqueue(request);
          break;
        case 'freeze_market':
        case 'unfreeze_market':
        case 'invalidate_position_lot':
          queue = await options.control.enqueue(request);
          break;
        default:
          throw new EscrowAttestationWorkerError('invalid_payload');
      }
      if (queue.kind !== 'enqueued' || queue.jobId === undefined) {
        throw new EscrowAttestationWorkerError('enqueue_rejected');
      }
      requireTransition(await options.db.markAttestationEnqueued({
        ...lease(row, nowIso), relayerJobId: queue.jobId, nextCheckAtIso: options.nextCheckAt(nowIso),
      }));
      return { kind: 'enqueued', requestKey: row.requestKey, relayerJobId: queue.jobId };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error instanceof EscrowAttestationWorkerError && error.code === 'transition_rejected') throw error;
      const code = errorCode(error);
      return retry(row, nowIso, code);
    }
  }

  return {
    async runOnce(nowIso: string, limit: number): Promise<readonly EscrowAttestationWorkerResult[]> {
      const rows = await options.db.leaseAttestationRequests({ workerId: options.workerId, nowIso, limit });
      return Promise.all(rows.map((row) => process(row, nowIso)));
    },
  };
}

export type EscrowAttestationRequestWorker = ReturnType<typeof createEscrowAttestationRequestWorker>;
