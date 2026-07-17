import { describe, expect, it } from 'vitest';
import { isFinalizedSuccess } from '../src/finalization.js';

describe('finalized success gate', () => {
  it('does not emit success for a merely confirmed transaction', () => {
    // Given an error-free signature that has only reached confirmed commitment
    const status = { slot: 10, confirmations: 1, err: null, confirmationStatus: 'confirmed' } as const;

    // When the application evaluates whether success may be emitted
    const successful = isFinalizedSuccess(status);

    // Then success remains gated
    expect(successful).toBe(false);
  });

  it('emits success only for an error-free finalized transaction', () => {
    // Given an error-free signature at finalized commitment
    const status = { slot: 10, confirmations: null, err: null, confirmationStatus: 'finalized' } as const;

    // When the application evaluates whether success may be emitted
    const successful = isFinalizedSuccess(status);

    // Then success is available
    expect(successful).toBe(true);
  });
});
