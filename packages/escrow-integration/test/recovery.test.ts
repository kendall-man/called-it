import { describe, expect, it } from 'vitest';
import { recoveryDecision } from '../src/recovery.js';

describe('placement signature recovery', () => {
  it('accepts a finalized transaction without retrying', () => {
    // Given a finalized signature observed before its blockhash expires
    const input = { status: 'finalized', blockHeight: 50n, lastValidBlockHeight: 80n } as const;

    // When recovery classifies the observed signature
    const decision = recoveryDecision(input);

    // Then it completes without submitting a duplicate
    expect(decision).toEqual({ kind: 'finalized' });
  });

  it('retries an unknown signature only while its blockhash remains valid', () => {
    // Given the RPC has no status and the original blockhash is still usable
    const input = { status: 'unknown', blockHeight: 50n, lastValidBlockHeight: 80n } as const;

    // When recovery classifies the unknown signature
    const decision = recoveryDecision(input);

    // Then the exact signed bytes may be submitted again
    expect(decision).toEqual({ kind: 'retry_exact_bytes' });
  });

  it('expires an unknown signature after its blockhash is no longer valid', () => {
    // Given the RPC has no status after the last valid block height
    const input = { status: 'unknown', blockHeight: 81n, lastValidBlockHeight: 80n } as const;

    // When recovery classifies the unknown signature
    const decision = recoveryDecision(input);

    // Then it requires a fresh intent instead of risking a changed transaction
    expect(decision).toEqual({ kind: 'expired' });
  });
});
