import type { Connection } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { EscrowEventProjector } from './event-projector.js';
import { SolanaFinalizedEscrowEventSource } from './solana-finalized-source.js';

const PROGRAM_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';

describe('Solana finalized escrow event source', () => {
  it('marks an idle scan through the finalized chain head', async () => {
    const connection = {
      getGenesisHash: async () => 'devnet-genesis',
      getSlot: async () => 900,
      getSignaturesForAddress: async () => [],
      getTransaction: async () => {
        throw new Error('idle scan must not fetch a transaction');
      },
    } as unknown as Connection;
    const projector: EscrowEventProjector = {
      async project() {
        throw new Error('idle scan must not project an event');
      },
    };
    const source = new SolanaFinalizedEscrowEventSource(
      connection,
      { genesisHash: 'devnet-genesis', programId: PROGRAM_ID },
      projector,
    );

    await expect(source.scan({ slot: 42n, signature: 'signature-a' }, 100))
      .resolves.toEqual({ transactions: [], scannedThroughSlot: 900n });
  });
});
