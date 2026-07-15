import type {
  EscrowAsset,
  EscrowCluster,
  EscrowIndexResult,
} from './escrow-types.js';

export const ESCROW_ATTESTATION_OPERATION_KINDS = [
  'freeze',
  'unfreeze',
  'invalidate',
  'settle',
  'void',
] as const;
export type EscrowAttestationOperationKind =
  (typeof ESCROW_ATTESTATION_OPERATION_KINDS)[number];

export const ESCROW_ATTESTATION_STATES = [
  'pending',
  'leased',
  'signed',
  'enqueued',
  'completed',
  'failed',
] as const;
export type EscrowAttestationState = (typeof ESCROW_ATTESTATION_STATES)[number];

interface ConfigureEscrowGroupRolloutInputBase {
  readonly groupId: number;
  readonly enabledBy: number | null;
  readonly nowIso: string;
}

export type ConfigureEscrowGroupRolloutInput =
  | ConfigureEscrowGroupRolloutInputBase & {
      readonly custodyMode: 'legacy';
      readonly cluster: null;
      readonly genesisHash: null;
      readonly programId: null;
      readonly custodyVersion: null;
    }
  | ConfigureEscrowGroupRolloutInputBase & {
      readonly custodyMode: 'escrow';
      readonly cluster: EscrowCluster;
      readonly genesisHash: string;
      readonly programId: string;
      readonly custodyVersion: number;
    };

export interface GetEscrowGroupRolloutInput {
  readonly groupId: number;
}

export interface EscrowGroupRolloutRow {
  readonly groupId: number;
  readonly custodyMode: 'legacy' | 'escrow';
  readonly cluster: EscrowCluster | null;
  readonly genesisHash: string | null;
  readonly programId: string | null;
  readonly custodyVersion: number | null;
  readonly enabledBy: number | null;
  readonly updatedAtIso: string;
}

export type ConfigureEscrowGroupRolloutResult = {
  readonly ok: true;
  readonly created: boolean;
} & EscrowGroupRolloutRow;

export type GetEscrowGroupRolloutResult =
  | { readonly ok: true; readonly found: false }
  | ({ readonly ok: true; readonly found: true } & EscrowGroupRolloutRow);

export interface EscrowMarketClosedInput {
  readonly signature: string;
  readonly instructionIndex: number;
  readonly marketId: string;
  readonly cluster: EscrowCluster;
  readonly genesisHash: string;
  readonly programId: string;
  readonly marketPda: string;
  readonly documentHashHex: string;
  readonly asset: EscrowAsset;
  readonly dustAmountAtomic: bigint;
  readonly slot: bigint;
  readonly blockTimeIso: string | null;
  readonly commitment: 'finalized';
  readonly observedAtIso: string;
}

export interface EnqueueEscrowAttestationRequestInput {
  readonly requestKey: string;
  readonly operationKind: EscrowAttestationOperationKind;
  readonly cluster: EscrowCluster;
  readonly genesisHash: string;
  readonly programId: string;
  readonly custodyVersion: number;
  readonly marketId: string;
  readonly marketPda: string;
  readonly documentHashHex: string;
  readonly oracleEpoch: bigint;
  readonly eventEpoch: bigint;
  readonly unsignedPayload: Readonly<Record<string, unknown>>;
  readonly unsignedPayloadHashHex: string;
  readonly dueAtIso: string;
  /** Null means immediate; SQL persists dueAtIso as the durable debounce boundary. */
  readonly debounceUntilIso: string | null;
  readonly maxAttempts: number;
  readonly leaseMs?: number;
  readonly nowIso: string;
}

export interface LeaseEscrowAttestationRequestsInput {
  readonly workerId: string;
  readonly nowIso: string;
  readonly limit: number;
}

export interface EscrowAttestationRequestRow {
  readonly requestKey: string;
  readonly operationKind: EscrowAttestationOperationKind;
  readonly state: EscrowAttestationState;
  readonly cluster: EscrowCluster;
  readonly genesisHash: string;
  readonly programId: string;
  readonly custodyVersion: number;
  readonly marketId: string;
  readonly marketPda: string;
  readonly documentHashHex: string;
  readonly oracleEpoch: bigint;
  readonly eventEpoch: bigint;
  readonly unsignedPayload: Readonly<Record<string, unknown>>;
  readonly unsignedPayloadHashHex: string;
  readonly signedPayload: Readonly<Record<string, unknown>> | null;
  readonly signedPayloadHashHex: string | null;
  readonly dueAtIso: string;
  readonly debounceUntilIso: string;
  readonly relayerJobId: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseDurationMs: number;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAtIso: string | null;
  readonly errorCode: string | null;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  readonly signedAtIso: string | null;
  readonly enqueuedAtIso: string | null;
  readonly completedAtIso: string | null;
  readonly failedAtIso: string | null;
}

export interface EscrowAttestationLeaseTransitionInput {
  readonly requestKey: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly nowIso: string;
}

export interface RecordEscrowAttestationSignedInput
  extends EscrowAttestationLeaseTransitionInput {
  readonly signedPayload: Readonly<Record<string, unknown>>;
  readonly signedPayloadHashHex: string;
}

export interface MarkEscrowAttestationEnqueuedInput
  extends EscrowAttestationLeaseTransitionInput {
  readonly relayerJobId: string;
  readonly nextCheckAtIso: string;
}

export interface RetryEscrowAttestationRequestInput
  extends EscrowAttestationLeaseTransitionInput {
  readonly errorCode: string;
  readonly retryAtIso: string;
}

export type EscrowAttestationEnqueueResult = {
  readonly ok: true;
  readonly created: boolean;
  readonly requestKey: string;
};

export type EscrowAttestationMutationResult =
  | {
      readonly ok: true;
      readonly duplicate: boolean;
      readonly state: EscrowAttestationState;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'request_not_found'
        | 'lease_lost'
        | 'state_conflict'
        | 'payload_mismatch'
        | 'relayer_mismatch';
    };

export interface EscrowReleaseBlockersDb {
  configureGroupRollout(
    input: ConfigureEscrowGroupRolloutInput,
  ): Promise<ConfigureEscrowGroupRolloutResult>;
  getGroupRollout(input: GetEscrowGroupRolloutInput): Promise<GetEscrowGroupRolloutResult>;
  recordMarketClosed(input: EscrowMarketClosedInput): Promise<EscrowIndexResult>;
  enqueueAttestationRequest(
    input: EnqueueEscrowAttestationRequestInput,
  ): Promise<EscrowAttestationEnqueueResult>;
  leaseAttestationRequests(
    input: LeaseEscrowAttestationRequestsInput,
  ): Promise<readonly EscrowAttestationRequestRow[]>;
  recordAttestationSigned(
    input: RecordEscrowAttestationSignedInput,
  ): Promise<EscrowAttestationMutationResult>;
  markAttestationEnqueued(
    input: MarkEscrowAttestationEnqueuedInput,
  ): Promise<EscrowAttestationMutationResult>;
  completeAttestationRequest(
    input: EscrowAttestationLeaseTransitionInput,
  ): Promise<EscrowAttestationMutationResult>;
  retryAttestationRequest(
    input: RetryEscrowAttestationRequestInput,
  ): Promise<EscrowAttestationMutationResult>;
}
