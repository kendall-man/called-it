import { createHash } from 'node:crypto';
import type {
  EnqueueEscrowAttestationRequestInput,
  EscrowAttestationEnqueueResult,
  EscrowAttestationOperationKind as DatabaseOperationKind,
} from '@calledit/db';
import type { EscrowOracleAttestationPolicy } from './attestation-signers.js';
import {
  attestationPayloadHash,
  createUnsignedAttestationPayload,
  type EscrowUnsignedWorkflowRequest,
} from './attestation-request-payload.js';

export type EscrowAttestationOperationKind = DatabaseOperationKind;

type DurableEnqueueInput = Omit<
  EnqueueEscrowAttestationRequestInput,
  'debounceUntilIso' | 'leaseMs'
> & {
  readonly debounceUntilIso: string;
  readonly leaseMs: number;
};

export interface EscrowAttestationRequestDatabase {
  enqueueAttestationRequest(input: DurableEnqueueInput): Promise<EscrowAttestationEnqueueResult>;
}

function operationKind(request: EscrowUnsignedWorkflowRequest): EscrowAttestationOperationKind {
  switch (request.operation) {
    case 'freeze_market': return 'freeze';
    case 'unfreeze_market': return 'unfreeze';
    case 'invalidate_position_lot': return 'invalidate';
    case 'settle_market': return 'settle';
    case 'void_market': return 'void';
  }
}

function timestamp(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`invalid escrow attestation ${name}`);
}

export function attestationRequestKey(unsignedPayloadHashHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(unsignedPayloadHashHex)) {
    throw new TypeError('invalid escrow attestation payload hash');
  }
  return createHash('sha256')
    .update('calledit.escrow.attestation-request.v1\0')
    .update(unsignedPayloadHashHex)
    .digest('hex');
}

export function createEscrowAttestationRequestService(options: {
  readonly db: EscrowAttestationRequestDatabase;
  readonly deployment: {
    readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
    readonly genesisHash: string;
    readonly programId: string;
    readonly custodyVersion: number;
  };
  readonly maxAttempts: number;
  readonly leaseMs: number;
  readonly clock: () => string;
}) {
  return {
    async enqueue(input: {
      readonly marketId: string;
      readonly documentHashHex: string;
      readonly claimSpecificationJson: string;
      readonly eventEpoch: bigint;
      readonly replay: boolean;
      readonly oraclePolicy: EscrowOracleAttestationPolicy;
      readonly request: EscrowUnsignedWorkflowRequest;
      readonly dueAtIso: string;
      readonly debounceUntilIso: string | null;
    }) {
      const nowIso = options.clock();
      timestamp(nowIso, 'clock');
      timestamp(input.dueAtIso, 'due time');
      const debounceUntilIso = input.debounceUntilIso ?? input.dueAtIso;
      timestamp(debounceUntilIso, 'debounce');
      const payload = createUnsignedAttestationPayload(input);
      const unsignedPayloadHashHex = attestationPayloadHash(payload);
      const requestKey = attestationRequestKey(unsignedPayloadHashHex);
      const result = await options.db.enqueueAttestationRequest({
        requestKey, operationKind: operationKind(input.request),
        cluster: options.deployment.cluster, genesisHash: options.deployment.genesisHash,
        programId: options.deployment.programId, custodyVersion: options.deployment.custodyVersion,
        marketId: input.marketId, marketPda: input.request.marketPda,
        documentHashHex: input.documentHashHex.toLowerCase(), oracleEpoch: input.oraclePolicy.oracleSetEpoch,
        eventEpoch: input.eventEpoch, unsignedPayload: payload, unsignedPayloadHashHex,
        dueAtIso: input.dueAtIso, debounceUntilIso,
        maxAttempts: options.maxAttempts, leaseMs: options.leaseMs, nowIso,
      });
      if (result.requestKey !== requestKey) throw new TypeError('escrow attestation request key mismatch');
      return { kind: 'persisted' as const, created: result.created, requestKey };
    },
  };
}

export type EscrowAttestationRequestService = ReturnType<typeof createEscrowAttestationRequestService>;
