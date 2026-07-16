export type ObservedSignatureStatus = 'finalized' | 'failed' | 'unknown';

export interface RecoveryInput {
  readonly status: ObservedSignatureStatus;
  readonly blockHeight: bigint;
  readonly lastValidBlockHeight: bigint;
}

export type RecoveryDecision =
  | { readonly kind: 'finalized' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'retry_exact_bytes' }
  | { readonly kind: 'expired' };

export function recoveryDecision(input: RecoveryInput): RecoveryDecision {
  switch (input.status) {
    case 'finalized':
      return { kind: 'finalized' };
    case 'failed':
      return { kind: 'failed' };
    case 'unknown':
      return input.blockHeight <= input.lastValidBlockHeight
        ? { kind: 'retry_exact_bytes' }
        : { kind: 'expired' };
  }
}
