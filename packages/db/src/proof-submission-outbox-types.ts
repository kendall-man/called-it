export const PROOF_SUBMISSION_OUTBOX_STATES = [
  'prepared',
  'broadcast',
  'landed',
  'expired',
] as const;
export type ProofSubmissionOutboxState = (typeof PROOF_SUBMISSION_OUTBOX_STATES)[number];

export type ProofSubmissionOutboxRpcCode =
  | 'market_not_found'
  | 'proof_not_pending'
  | 'submission_not_found'
  | 'submission_identity_conflict'
  | 'submission_not_active';

export interface ProofSubmissionOutboxRow {
  readonly marketId: string;
  readonly attempt: number;
  readonly state: ProofSubmissionOutboxState;
  readonly signature: string;
  readonly rawTxB64: string;
  readonly lastValidBlockHeight: number;
  readonly proofPayload: Readonly<Record<string, unknown>>;
  readonly broadcastCount: number;
  readonly preparedAt: string;
  readonly lastBroadcastAt: string | null;
  readonly landedAt: string | null;
  readonly expiredAt: string | null;
  readonly updatedAt: string;
}

export interface PrepareProofSubmissionInput {
  readonly marketId: string;
  readonly signature: string;
  readonly rawTxB64: string;
  readonly lastValidBlockHeight: number;
  readonly proofPayload: Readonly<Record<string, unknown>>;
  readonly nowIso: string;
}

export interface ProofSubmissionIdentity {
  readonly marketId: string;
  readonly attempt: number;
  readonly signature: string;
  readonly nowIso: string;
}

export type GetProofSubmissionResult =
  | { readonly ok: true; readonly outbox: ProofSubmissionOutboxRow | null }
  | { readonly ok: false; readonly code: ProofSubmissionOutboxRpcCode };

export type ProofSubmissionMutationResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly outbox: ProofSubmissionOutboxRow }
  | { readonly ok: false; readonly code: ProofSubmissionOutboxRpcCode };

export interface ProofSubmissionOutboxDb {
  get(marketId: string): Promise<GetProofSubmissionResult>;
  prepare(input: PrepareProofSubmissionInput): Promise<ProofSubmissionMutationResult>;
  markBroadcast(input: ProofSubmissionIdentity): Promise<ProofSubmissionMutationResult>;
  markLanded(input: ProofSubmissionIdentity): Promise<ProofSubmissionMutationResult>;
  markExpired(input: ProofSubmissionIdentity): Promise<ProofSubmissionMutationResult>;
}
