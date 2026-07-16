import { describe, expect, it } from 'vitest';
import {
  createEscrowFinalizedIndexerHealthSource,
  escrowNetworkForGenesisHash,
} from './solana-readiness.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const NOW = Date.parse('2026-07-15T00:00:00.000Z');

describe('escrow Solana genesis identity', () => {
  it('recognizes only the exact full devnet and mainnet-beta genesis hashes', () => {
    expect(escrowNetworkForGenesisHash(DEVNET_GENESIS)).toBe('devnet');
    expect(escrowNetworkForGenesisHash(MAINNET_GENESIS)).toBe('mainnet-beta');
    expect(escrowNetworkForGenesisHash('EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe('localnet');
    expect(escrowNetworkForGenesisHash('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2pQd')).toBe('localnet');
  });
});

describe('escrow finalized indexer health', () => {
  it('measures lag from the latest successful scan rather than the last event cursor', async () => {
    const health = createEscrowFinalizedIndexerHealthSource({
      watermark: {
        scanWatermark: () => ({
          slot: 990n,
          scannedAtIso: new Date(NOW - 1_000).toISOString(),
        }),
      },
      finalizedSlot: async () => 1_000n,
      now: () => NOW,
      maxScanAgeMs: 30_000,
    });

    await expect(health.inspect(new AbortController().signal)).resolves.toEqual({
      available: true,
      lagSlots: 10n,
    });
  });

  it.each([
    ['never completed', null],
    ['is stale', { slot: 990n, scannedAtIso: new Date(NOW - 30_001).toISOString() }],
  ] as const)('is unavailable when a finalized scan %s', async (_name, scanWatermark) => {
    const health = createEscrowFinalizedIndexerHealthSource({
      watermark: { scanWatermark: () => scanWatermark },
      finalizedSlot: async () => 1_000n,
      now: () => NOW,
      maxScanAgeMs: 30_000,
    });

    await expect(health.inspect(new AbortController().signal)).resolves.toEqual({
      available: false,
      lagSlots: 0n,
    });
  });
});
