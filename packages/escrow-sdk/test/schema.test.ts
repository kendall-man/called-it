import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { DEVNET_ESCROW_PROGRAM_ID } from '../src/schema.js';

describe('escrow deployment schema', () => {
  it('keeps the repository devnet program identity explicit and unchanged', () => {
    expect(new PublicKey(DEVNET_ESCROW_PROGRAM_ID).toBase58()).toBe(
      'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL',
    );
  });
});
