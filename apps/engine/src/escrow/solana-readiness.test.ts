import { describe, expect, it } from 'vitest';
import { escrowNetworkForGenesisHash } from './solana-readiness.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

describe('escrow Solana genesis identity', () => {
  it('recognizes only the exact full devnet and mainnet-beta genesis hashes', () => {
    expect(escrowNetworkForGenesisHash(DEVNET_GENESIS)).toBe('devnet');
    expect(escrowNetworkForGenesisHash(MAINNET_GENESIS)).toBe('mainnet-beta');
    expect(escrowNetworkForGenesisHash('EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe('localnet');
    expect(escrowNetworkForGenesisHash('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2pQd')).toBe('localnet');
  });
});
