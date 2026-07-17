import type { SignatureStatus } from '@solana/web3.js';

export function isFinalizedSuccess(status: SignatureStatus | null): boolean {
  return status !== null
    && status.err === null
    && status.confirmationStatus === 'finalized';
}
