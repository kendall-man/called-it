import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  compiledEscrowProgramIdForNetwork,
  DEVNET_ESCROW_PROGRAM_ID,
  ESCROW_COMPILED_PROGRAM_ID_BY_NETWORK,
} from '../src/schema.js';

describe('escrow deployment schema', () => {
  it('keeps the repository devnet program identity explicit and unchanged', () => {
    expect(new PublicKey(DEVNET_ESCROW_PROGRAM_ID).toBase58()).toBe(
      'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL',
    );
    expect(ESCROW_COMPILED_PROGRAM_ID_BY_NETWORK.devnet).toBe(DEVNET_ESCROW_PROGRAM_ID);
    expect(compiledEscrowProgramIdForNetwork('devnet')).toBe(DEVNET_ESCROW_PROGRAM_ID);
  });

  it('has no compiled mainnet identity before the mainnet approval gate', () => {
    expect(ESCROW_COMPILED_PROGRAM_ID_BY_NETWORK['mainnet-beta']).toBeNull();
    expect(compiledEscrowProgramIdForNetwork('mainnet-beta')).toBeNull();
  });
});
