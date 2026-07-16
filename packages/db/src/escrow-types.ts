export const ESCROW_CLUSTERS = ['localnet', 'devnet', 'mainnet-beta'] as const;
export type EscrowCluster = (typeof ESCROW_CLUSTERS)[number];

export type EscrowCustodyMode = 'legacy' | 'escrow';
export type EscrowAsset = 'sol' | 'usdc';
export type EscrowSide = 'back' | 'doubt';
export type EscrowCommitment = 'confirmed' | 'finalized';
export type EscrowPositionState = 'pending' | 'active' | 'invalidated' | 'refundable' | 'claimed';
export type EscrowPositionEventKind =
  | 'placed'
  | 'activated'
  | 'invalidated'
  | 'refundable'
  | 'claimed';
export type EscrowSettlementOutcome = 'claim_won' | 'claim_lost' | 'void';

export const ESCROW_RELAYER_JOB_KINDS = [
  'market_initialization',
  'freeze',
  'unfreeze',
  'position_activation',
  'position_invalidation',
  'settlement_submission',
  'timeout_monitoring',
  'auto_claim',
  'account_close',
] as const;
export type EscrowRelayerJobKind = (typeof ESCROW_RELAYER_JOB_KINDS)[number];

export const ESCROW_RELAYER_JOB_STATES = [
  'pending',
  'leased',
  'signed',
  'submitted',
  'unknown',
  'retry_wait',
  'complete',
  'dead',
] as const;
export type EscrowRelayerJobState = (typeof ESCROW_RELAYER_JOB_STATES)[number];

export type EscrowSigningSessionState = 'pending' | 'consumed' | 'cancelled' | 'expired';
export type EscrowReconciliationStatus = 'in_sync' | 'drift' | 'unavailable';

export interface EscrowMarketLinkInput {
  readonly marketId: string;
  readonly custodyMode: 'escrow';
  readonly custodyVersion: number;
  readonly cluster: EscrowCluster;
  readonly genesisHash: string;
  readonly programId: string;
  readonly marketPda: string;
  readonly vaultPda: string;
  readonly asset: EscrowAsset;
  readonly mintPubkey: string | null;
  readonly documentHashHex: string;
  readonly initializeSignature: string;
  readonly initializeInstructionIndex: number;
  readonly initializeSlot: bigint;
  readonly initializeBlockTimeIso: string | null;
  readonly oracleEpoch: bigint;
  readonly eventEpoch: bigint;
  readonly ratioMilli: bigint;
  readonly commitment: EscrowCommitment;
  readonly observedAtIso: string;
}

export interface EscrowPositionEventInput {
  readonly signature: string;
  readonly instructionIndex: number;
  readonly marketId: string;
  readonly programId: string;
  readonly positionPda: string;
  readonly ownerPubkey: string;
  readonly lotNonce: bigint;
  readonly eventKind: EscrowPositionEventKind;
  readonly side: EscrowSide;
  readonly asset: EscrowAsset;
  readonly amountAtomic: bigint;
  readonly eventEpoch: bigint;
  readonly state: EscrowPositionState;
  readonly slot: bigint;
  readonly blockTimeIso: string | null;
  readonly commitment: EscrowCommitment;
  readonly observedAtIso: string;
}

export interface EscrowPositionAccountInput {
  readonly marketId: string;
  readonly programId: string;
  readonly ownerPubkey: string;
  readonly positionPda: string;
  readonly side: EscrowSide;
  readonly asset: EscrowAsset;
  readonly depositedAtomic: bigint;
  readonly pendingAtomic: bigint;
  readonly activeAtomic: bigint;
  readonly refundableAtomic: bigint;
  readonly claimedAtomic: bigint;
  readonly nextLotNonce: bigint;
  readonly sourceSlot: bigint;
  readonly commitment: EscrowCommitment;
  readonly observedAtIso: string;
}

export interface EscrowSettlementEventInput {
  readonly signature: string;
  readonly instructionIndex: number;
  readonly marketId: string;
  readonly programId: string;
  readonly outcome: EscrowSettlementOutcome;
  readonly evidenceHashHex: string;
  readonly documentHashHex: string;
  readonly oracleEpoch: bigint;
  readonly slot: bigint;
  readonly blockTimeIso: string | null;
  readonly commitment: EscrowCommitment;
  readonly observedAtIso: string;
}

export interface EscrowClaimEventInput {
  readonly signature: string;
  readonly instructionIndex: number;
  readonly marketId: string;
  readonly programId: string;
  readonly ownerPubkey: string;
  readonly destinationPubkey: string;
  readonly asset: EscrowAsset;
  readonly amountAtomic: bigint;
  readonly claimKind: 'payout' | 'refund';
  readonly slot: bigint;
  readonly blockTimeIso: string | null;
  readonly commitment: EscrowCommitment;
  readonly observedAtIso: string;
}

export interface EscrowIndexResult {
  readonly ok: true;
  readonly duplicate: boolean;
  readonly finalized: boolean;
}

export interface AdvanceEscrowChainCursorInput {
  readonly cluster: EscrowCluster;
  readonly genesisHash: string;
  readonly programId: string;
  readonly commitment: EscrowCommitment;
  readonly slot: bigint;
  readonly signature: string;
  readonly nowIso: string;
}

export interface RewindEscrowConfirmedChainInput {
  readonly cluster: EscrowCluster;
  readonly programId: string;
  readonly rewindSlot: bigint;
  readonly nowIso: string;
}

export interface RewindEscrowConfirmedChainResult {
  readonly ok: true;
  readonly orphanedEvents: number;
  readonly rewindSlot: bigint;
}

export interface RecordEscrowReconciliationInput {
  readonly marketId: string;
  readonly cluster: EscrowCluster;
  readonly programId: string;
  readonly checkedSlot: bigint;
  readonly vaultBalanceAtomic: bigint;
  readonly liabilityAtomic: bigint;
  readonly positionAccountCount: number;
  readonly status: EscrowReconciliationStatus;
  readonly details: Readonly<Record<string, unknown>>;
  readonly checkedAtIso: string;
}

export interface CreateEscrowSigningSessionInput {
  readonly tokenHashHex: string;
  readonly userId: number;
  readonly providerUserId: string;
  readonly providerWalletId: string;
  readonly ownerPubkey: string;
  readonly marketId: string;
  readonly side: EscrowSide;
  readonly asset: EscrowAsset;
  readonly amountAtomic: bigint;
  readonly lotNonce: bigint;
  readonly eventEpoch: bigint;
  readonly documentHashHex: string;
  readonly transactionMessageHashHex: string;
  readonly expiresAtIso: string;
  readonly nowIso: string;
}

export interface ConsumeEscrowSigningSessionInput {
  readonly tokenHashHex: string;
  readonly userId: number;
  readonly providerUserId: string;
  readonly providerWalletId: string;
  readonly ownerPubkey: string;
  readonly marketId: string;
  readonly transactionMessageHashHex: string;
  readonly transactionSignature: string;
  readonly nowIso: string;
}

/**
 * Atomically consumes a verified signing session and persists its placement
 * outbox entry. The market and owner are derived from the locked session.
 */
export interface ConsumeEscrowSigningSessionAndEnqueuePlacementInput
  extends ConsumeEscrowSigningSessionInput {
  readonly idempotencyKey: string;
  readonly cluster: EscrowCluster;
  readonly programId: string;
  readonly custodyMode: 'escrow';
  readonly custodyVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly dueAtIso: string;
  readonly maxAttempts: number;
  readonly leaseMs?: number;
}

export type EscrowSigningSessionResult =
  | { readonly ok: true; readonly created: boolean }
  | { readonly ok: true; readonly duplicate: boolean; readonly state: 'consumed' }
  | {
      readonly ok: false;
      readonly code:
        | 'invalid_input'
        | 'session_not_found'
        | 'session_expired'
        | 'session_consumed'
        | 'binding_mismatch';
    };

export type ConsumeEscrowSigningSessionAndEnqueuePlacementResult =
  | {
      readonly ok: true;
      readonly duplicate: boolean;
      readonly state: 'consumed';
      readonly jobCreated: boolean;
      readonly jobId: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'invalid_input'
        | 'session_not_found'
        | 'session_expired'
        | 'session_consumed'
        | 'binding_mismatch';
    };

export interface ListEscrowReconciliationLinksInput {
  readonly cluster: EscrowCluster;
  readonly genesisHash: string;
  readonly programId: string;
  readonly custodyVersion: number;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface EscrowReconciliationLink {
  readonly marketId: string;
  readonly custodyMode: 'escrow';
  readonly marketPda: string;
  readonly vaultPda: string;
  readonly asset: EscrowAsset;
  /** A finalized snapshot must revalidate this quarantined link before recovery. */
  readonly revalidationRequired: boolean;
}

export interface ListEscrowReconciliationLinksResult {
  readonly links: readonly EscrowReconciliationLink[];
  readonly nextCursor: string | null;
}

export interface EnqueueEscrowRelayerJobInput {
  readonly kind: EscrowRelayerJobKind;
  readonly idempotencyKey: string;
  readonly cluster: EscrowCluster;
  readonly programId: string;
  readonly custodyMode: 'escrow';
  readonly custodyVersion: number;
  readonly marketId: string | null;
  readonly ownerPubkey: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly dueAtIso: string;
  readonly maxAttempts: number;
  readonly leaseMs?: number;
  readonly nowIso: string;
}

export interface LeaseEscrowRelayerJobsInput {
  readonly workerId: string;
  readonly nowIso: string;
  readonly limit: number;
}

export interface EscrowRelayerJobRow {
  readonly id: string;
  readonly kind: EscrowRelayerJobKind;
  readonly idempotencyKey: string;
  readonly state: EscrowRelayerJobState;
  readonly cluster: EscrowCluster;
  readonly programId: string;
  readonly custodyMode: 'escrow';
  readonly custodyVersion: number;
  readonly marketId: string | null;
  readonly ownerPubkey: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseDurationMs: number;
  readonly dueAt: string;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly expectedSignature: string | null;
  readonly rawTransactionBase64: string | null;
  readonly transactionMessageHashHex: string | null;
  readonly lastValidBlockHeight: bigint | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EscrowRelayerLeaseTransitionInput {
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly nowIso: string;
}

export interface RecordEscrowRelayerSignedTransactionInput extends EscrowRelayerLeaseTransitionInput {
  readonly rawTransactionBase64: string;
  readonly expectedSignature: string;
  readonly lastValidBlockHeight: bigint;
  readonly transactionMessageHashHex: string;
}

export interface MarkEscrowRelayerSubmittedInput extends EscrowRelayerLeaseTransitionInput {
  readonly expectedSignature: string;
}

export interface RetryEscrowRelayerJobInput extends EscrowRelayerLeaseTransitionInput {
  readonly errorCode: string;
  readonly retryAtIso: string;
  readonly confirmationUnknown: boolean;
  readonly fullHistoryCheckedAtIso?: string | null;
  readonly currentBlockHeight?: bigint | null;
}

export interface DeadLetterEscrowRelayerJobInput extends EscrowRelayerLeaseTransitionInput {
  readonly errorCode: string;
}

export type EscrowRelayerMutationResult =
  | { readonly ok: true; readonly created: boolean; readonly jobId: string }
  | { readonly ok: true; readonly duplicate: boolean; readonly state: EscrowRelayerJobState }
  | { readonly ok: false; readonly code: 'job_not_found' | 'lease_lost' | 'state_conflict' | 'signature_mismatch' };

export interface EscrowRelayerBacklog {
  readonly readyCount: number;
  readonly leasedCount: number;
  readonly unknownCount: number;
  readonly submittedCount: number;
  readonly deadCount: number;
  readonly oldestReadyAgeMs: number | null;
}

export interface EscrowDb {
  upsertMarketLink(input: EscrowMarketLinkInput): Promise<EscrowIndexResult>;
  recordPositionEvent(input: EscrowPositionEventInput): Promise<EscrowIndexResult>;
  upsertPositionAccount(input: EscrowPositionAccountInput): Promise<EscrowIndexResult>;
  recordSettlementEvent(input: EscrowSettlementEventInput): Promise<EscrowIndexResult>;
  recordClaimEvent(input: EscrowClaimEventInput): Promise<EscrowIndexResult>;
  advanceChainCursor(input: AdvanceEscrowChainCursorInput): Promise<EscrowIndexResult>;
  rewindConfirmedChain(input: RewindEscrowConfirmedChainInput): Promise<RewindEscrowConfirmedChainResult>;
  recordReconciliation(input: RecordEscrowReconciliationInput): Promise<EscrowIndexResult>;
  createSigningSession(input: CreateEscrowSigningSessionInput): Promise<EscrowSigningSessionResult>;
  consumeSigningSession(input: ConsumeEscrowSigningSessionInput): Promise<EscrowSigningSessionResult>;
  consumeSigningSessionAndEnqueuePlacement(
    input: ConsumeEscrowSigningSessionAndEnqueuePlacementInput,
  ): Promise<ConsumeEscrowSigningSessionAndEnqueuePlacementResult>;
  listReconciliationLinks(
    input: ListEscrowReconciliationLinksInput,
  ): Promise<ListEscrowReconciliationLinksResult>;
  enqueueRelayerJob(input: EnqueueEscrowRelayerJobInput): Promise<EscrowRelayerMutationResult>;
  leaseRelayerJobs(input: LeaseEscrowRelayerJobsInput): Promise<readonly EscrowRelayerJobRow[]>;
  recordRelayerSignedTransaction(input: RecordEscrowRelayerSignedTransactionInput): Promise<EscrowRelayerMutationResult>;
  markRelayerSubmitted(input: MarkEscrowRelayerSubmittedInput): Promise<EscrowRelayerMutationResult>;
  retryRelayerJob(input: RetryEscrowRelayerJobInput): Promise<EscrowRelayerMutationResult>;
  completeRelayerJob(input: EscrowRelayerLeaseTransitionInput): Promise<EscrowRelayerMutationResult>;
  deadLetterRelayerJob(input: DeadLetterEscrowRelayerJobInput): Promise<EscrowRelayerMutationResult>;
  relayerBacklog(nowIso: string): Promise<EscrowRelayerBacklog>;
}
