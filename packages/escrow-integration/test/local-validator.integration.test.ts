import { describe, expect, it } from 'vitest';
import { runLocalValidatorScenario } from '../src/scenario.js';

describe.sequential('Called It escrow on solana-test-validator', () => {
  it('preserves custody and recovery invariants across SOL and USDC', async () => {
    // Given a reset validator with the expected upgradeable escrow program deployed
    const result = await runLocalValidatorScenario();

    // When the complete adversarial lifecycle finishes
    // Then every required phase has produced observable on-chain evidence
    expect(result).toEqual({
      bootstrap: true,
      placements: true,
      antiSnipe: true,
      settlement: true,
      voids: true,
      replayPath: true,
      recovery: true,
      closeGuards: true,
    });
  });
});
