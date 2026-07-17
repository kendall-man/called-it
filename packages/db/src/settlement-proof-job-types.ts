export const SETTLEMENT_PROOF_JOB_KINDS = ['settlement', 'proof'] as const;
export type SettlementProofJobKind = (typeof SETTLEMENT_PROOF_JOB_KINDS)[number];

export const SETTLEMENT_PROOF_JOB_STATUSES = [
  'pending',
  'leased',
  'retry_wait',
  'complete',
  'dead',
] as const;
export type SettlementProofJobStatus = (typeof SETTLEMENT_PROOF_JOB_STATUSES)[number];

export const SETTLEMENT_PROOF_STATES = ['pending', 'verified', 'failed', 'unavailable'] as const;
export type SettlementProofState = (typeof SETTLEMENT_PROOF_STATES)[number];

export type SettlementProofOutcome = 'claim_won' | 'claim_lost' | 'void';
export type SettlementProofTier = 'chain_proven' | 'oracle_resolved';
export type SettlementProofKind = 'stat' | 'odds';

export type SettlementJobErrorCode =
  | 'database_unavailable'
  | 'settlement_fact_missing'
  | 'settlement_fact_conflict'
  | 'settlement_rederive_failed'
  | 'wager_apply_failed'
  | 'proof_enqueue_failed'
  | 'chat_delivery_failed'
  | 'chat_ownership_pending'
  | 'lease_expired'
  | 'unexpected_error';

export type ProofJobErrorCode =
  | 'database_unavailable'
  | 'settlement_fact_missing'
  | 'proof_submission_disabled'
  | 'proof_fetch_failed'
  | 'proof_payload_invalid'
  | 'proof_submit_failed'
  | 'proof_verify_pending'
  | 'proof_verify_failed'
  | 'lease_expired'
  | 'unexpected_error';

export type SettlementProofJobErrorCode = SettlementJobErrorCode | ProofJobErrorCode;

export type SettlementProofRpcCode =
  | 'market_not_found'
  | 'market_not_sol'
  | 'market_not_terminal'
  | 'terminal_state_conflict'
  | 'tier_mismatch'
  | 'settlement_fact_missing'
  | 'settlement_fact_conflict'
  | 'proof_fact_conflict'
  | 'verified_shape_invalid'
  | 'invalid_job_kind'
  | 'invalid_queue_policy'
  | 'lease_lost'
  | 'effects_incomplete'
  | 'proof_terminal_missing';

export interface SettlementProofJobRow {
  readonly marketId: string;
  readonly jobKind: SettlementProofJobKind;
  readonly status: SettlementProofJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly dueAt: string;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leasedAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastErrorCode: SettlementProofJobErrorCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly deadAt: string | null;
}

export interface RecordTerminalSettlementInput {
  readonly marketId: string;
  readonly outcome: SettlementProofOutcome;
  readonly decidingSeq: number | null;
  readonly evidenceSeqs: readonly number[];
  readonly tier: SettlementProofTier;
  readonly nowIso: string;
  readonly maxAttempts: number;
  readonly leaseMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export type RecordTerminalSettlementResult =
  | {
      readonly ok: true;
      readonly duplicate: boolean;
      readonly marketId: string;
      readonly jobStatus: SettlementProofJobStatus;
    }
  | { readonly ok: false; readonly code: SettlementProofRpcCode };

export type SettlementPostedResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly postedAt: string }
  | { readonly ok: false; readonly code: Extract<SettlementProofRpcCode, 'settlement_fact_missing'> };

export interface RecordProofStateInput {
  readonly marketId: string;
  readonly kind: SettlementProofKind;
  readonly statKey: number | null;
  readonly seq: number | null;
  readonly merkleProof: Readonly<Record<string, unknown>> | null;
  readonly validateStatTx: string | null;
  readonly explorerUrl: string | null;
  readonly status: SettlementProofState;
  readonly nowIso: string;
}

export type RecordProofStateResult =
  | {
      readonly ok: true;
      readonly duplicate: boolean;
      readonly marketId: string;
      readonly kind: SettlementProofKind;
      readonly status: SettlementProofState;
      readonly verifiedAt: string | null;
    }
  | { readonly ok: false; readonly code: SettlementProofRpcCode };

export interface QueuePolicyInput {
  readonly maxAttempts: number;
  readonly leaseMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export interface EnqueueSettlementProofJobInput extends QueuePolicyInput {
  readonly marketId: string;
  readonly jobKind: SettlementProofJobKind;
  readonly dueAtIso: string;
  readonly nowIso: string;
}

export type EnqueueSettlementProofJobResult =
  | { readonly ok: true; readonly created: boolean; readonly job: SettlementProofJobRow }
  | { readonly ok: false; readonly code: SettlementProofRpcCode };

export interface LeaseSettlementProofJobsInput {
  readonly jobKind: SettlementProofJobKind;
  readonly workerId: string;
  readonly nowIso: string;
  readonly limit: number;
}

export interface CompleteSettlementProofJobInput {
  readonly marketId: string;
  readonly jobKind: SettlementProofJobKind;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly nowIso: string;
}

export interface RetrySettlementProofJobInput extends CompleteSettlementProofJobInput {
  readonly errorCode: SettlementProofJobErrorCode;
  readonly delayMs: number;
}

export interface DeadLetterSettlementProofJobInput extends CompleteSettlementProofJobInput {
  readonly errorCode: SettlementProofJobErrorCode;
}

export type JobTransitionResult =
  | {
      readonly ok: true;
      readonly status: Extract<SettlementProofJobStatus, 'retry_wait' | 'complete' | 'dead'>;
      readonly duplicate: boolean;
    }
  | { readonly ok: false; readonly code: SettlementProofRpcCode };

export interface TerminalSettlementGap {
  readonly marketId: string;
  readonly settlementJobMissing: boolean;
  readonly settlementRowMissing: boolean;
  readonly wagerMarkerMissing: boolean;
  readonly proofJobMissing: boolean;
  readonly proofTerminalMissing: boolean;
  readonly chatPostMissing: boolean;
  readonly settlementTerminalConflict: boolean;
  readonly proofTerminalConflict: boolean;
}

export type ReconcileTerminalJobReason =
  | 'settlement_job_missing'
  | 'settlement_fact_missing'
  | 'proof_job_missing'
  | 'settlement_terminal_conflict'
  | 'proof_terminal_conflict';

export interface ReconcileTerminalJobsInput extends QueuePolicyInput {
  readonly nowIso: string;
  readonly limit: number;
  readonly initialChainProofDelayMs: number;
}

export interface ReconcileTerminalJobResult {
  readonly marketId: string;
  readonly reasonCodes: readonly ReconcileTerminalJobReason[];
  readonly settlementJobCreated: boolean;
  readonly proofJobCreated: boolean;
}

export interface SettlementProofBacklog {
  readonly readyCount: number;
  readonly oldestReadyAgeMs: number | null;
  readonly activeLeaseCount: number;
  readonly retryWaitCount: number;
  readonly expiredLeaseCount: number;
  readonly deadCount: number;
}

export interface SettlementProofJobsDb {
  recordTerminalSettlement(input: RecordTerminalSettlementInput): Promise<RecordTerminalSettlementResult>;
  markSettlementPosted(marketId: string, nowIso: string): Promise<SettlementPostedResult>;
  recordProofState(input: RecordProofStateInput): Promise<RecordProofStateResult>;
  enqueueJob(input: EnqueueSettlementProofJobInput): Promise<EnqueueSettlementProofJobResult>;
  leaseJobs(input: LeaseSettlementProofJobsInput): Promise<readonly SettlementProofJobRow[]>;
  completeJob(input: CompleteSettlementProofJobInput): Promise<JobTransitionResult>;
  retryJob(input: RetrySettlementProofJobInput): Promise<JobTransitionResult>;
  deadLetterJob(input: DeadLetterSettlementProofJobInput): Promise<JobTransitionResult>;
  terminalGaps(limit: number): Promise<readonly TerminalSettlementGap[]>;
  reconcileTerminalJobs(input: ReconcileTerminalJobsInput): Promise<readonly ReconcileTerminalJobResult[]>;
  backlog(kind: SettlementProofJobKind, nowIso: string): Promise<SettlementProofBacklog>;
}
