import type { ProofSubmission } from '../ports.js';

export interface PreparedDurableProofSubmission {
  readonly signature: string;
  readonly rawTxB64: string;
  readonly lastValidBlockHeight: number;
}

export type DurableProofSubmissionPlan =
  | { readonly kind: 'landed' }
  | { readonly kind: 'onchain_failed' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'rebroadcast' }
  | { readonly kind: 'rebuild' };

export interface DurableProofSubmissionTransport {
  build(input: ProofSubmission): Promise<
    | { readonly ok: true; readonly submission: PreparedDurableProofSubmission }
    | { readonly ok: false }
  >;
  inspect(submission: PreparedDurableProofSubmission): Promise<
    | { readonly ok: true; readonly plan: DurableProofSubmissionPlan }
    | { readonly ok: false }
  >;
  rebroadcast(submission: PreparedDurableProofSubmission): Promise<
    | { readonly ok: true }
    | { readonly ok: false }
  >;
}
