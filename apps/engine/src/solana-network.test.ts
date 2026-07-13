import { describe, expect, it } from 'vitest';
import {
  expectedGenesisHash,
  explorerTxUrlForNetwork,
  rpcUrlLooksLikeDevnet,
} from './solana-network.js';

describe('Solana network profile', () => {
  it('uses cluster-qualified devnet links and canonical mainnet links', () => {
    expect(explorerTxUrlForNetwork('sig', 'devnet')).toBe(
      'https://explorer.solana.com/tx/sig?cluster=devnet',
    );
    expect(explorerTxUrlForNetwork('sig', 'mainnet-beta')).toBe(
      'https://explorer.solana.com/tx/sig',
    );
  });

  it('recognizes explicit devnet RPC endpoints without rejecting opaque mainnet providers', () => {
    expect(rpcUrlLooksLikeDevnet('https://api.devnet.solana.com')).toBe(true);
    expect(rpcUrlLooksLikeDevnet('https://rpc.example.com/solana-devnet')).toBe(true);
    expect(rpcUrlLooksLikeDevnet('https://rpc.provider.example/v1/opaque-key')).toBe(false);
  });

  it('pins distinct canonical genesis hashes', () => {
    expect(expectedGenesisHash('devnet')).not.toBe(expectedGenesisHash('mainnet-beta'));
  });
});
