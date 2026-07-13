import { describe, expect, it } from 'vitest';
import {
  isPrivySolanaWalletAccount,
  isPrivyWalletClientType,
} from './wallet-flow';

describe('wallet creation flow', () => {
  it('recognizes only Privy embedded wallet clients', () => {
    expect(isPrivyWalletClientType('privy')).toBe(true);
    expect(isPrivyWalletClientType('privy-v2')).toBe(false);
    expect(isPrivyWalletClientType('phantom')).toBe(false);
  });

  it('recognizes a Privy Solana wallet even when connector metadata is absent', () => {
    expect(isPrivySolanaWalletAccount({
      type: 'wallet',
      chainType: 'solana',
      walletClientType: 'privy',
      address: '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
    })).toBe(true);
    expect(isPrivySolanaWalletAccount({
      type: 'wallet',
      chainType: 'solana',
      walletClientType: 'phantom',
      address: '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
    })).toBe(false);
  });

});
