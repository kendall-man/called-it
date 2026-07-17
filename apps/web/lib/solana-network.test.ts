import { describe, expect, it } from 'vitest';
import { isMainnet, publicSolanaNetwork } from './solana-network';

describe('public Solana network', () => {
  it('keeps devnet as the compatibility default', () => {
    expect(publicSolanaNetwork(undefined)).toBe('devnet');
    expect(isMainnet(undefined)).toBe(false);
  });

  it('selects mainnet only through the explicit profile', () => {
    expect(publicSolanaNetwork('mainnet-beta')).toBe('mainnet-beta');
    expect(isMainnet('mainnet-beta')).toBe(true);
  });
});
