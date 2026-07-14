import type { EscrowDb } from '@calledit/db';
import { describe, expect, it } from 'vitest';
import {
  createFinalizedEscrowIndexer,
  EscrowFinalizedIndexerError,
  type EscrowFinalizedTransaction,
} from './finalized-indexer.js';

const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const PROGRAM_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';
const NOW = '2026-07-15T00:00:00.000Z';

function transaction(): EscrowFinalizedTransaction {
  return {
    signature: 'signature-a', slot: 42n, blockTimeIso: NOW,
    genesisHash: 'devnet-genesis', programId: PROGRAM_ID,
    events: [
      {
        instructionIndex: 0,
        projection: {
          kind: 'market', marketId: MARKET_ID, custodyVersion: 1,
          marketPda: 'market-a', vaultPda: 'vault-a', asset: 'sol', mintPubkey: null,
          documentHashHex: 'ab'.repeat(32), oracleEpoch: 9n, eventEpoch: 0n, ratioMilli: 1_500n,
        },
      },
      {
        instructionIndex: 1,
        projection: {
          kind: 'position', marketId: MARKET_ID, positionPda: 'position-a', ownerPubkey: 'owner-a',
          lotNonce: 0n, eventKind: 'placed', side: 'back', asset: 'sol', amountAtomic: 25n,
          eventEpoch: 0n, state: 'active',
        },
      },
    ],
  };
}

function setup(items: readonly EscrowFinalizedTransaction[]) {
  const identities = new Set<string>();
  const writes: string[] = [];
  const cursors: Parameters<EscrowDb['advanceChainCursor']>[0][] = [];
  const result = (identity: string) => {
    const duplicate = identities.has(identity);
    identities.add(identity);
    return { ok: true as const, duplicate, finalized: true };
  };
  const db: Pick<EscrowDb,
    'upsertMarketLink' | 'recordPositionEvent' | 'recordSettlementEvent' |
    'recordClaimEvent' | 'advanceChainCursor'> = {
      async upsertMarketLink(input) { writes.push(`market:${input.initializeSignature}:${input.initializeInstructionIndex}`); return result(writes.at(-1) ?? ''); },
      async recordPositionEvent(input) { writes.push(`position:${input.signature}:${input.instructionIndex}`); return result(writes.at(-1) ?? ''); },
      async recordSettlementEvent(input) { writes.push(`settlement:${input.signature}:${input.instructionIndex}`); return result(writes.at(-1) ?? ''); },
      async recordClaimEvent(input) { writes.push(`claim:${input.signature}:${input.instructionIndex}`); return result(writes.at(-1) ?? ''); },
      async advanceChainCursor(input) { cursors.push(input); return { ok: true, duplicate: false, finalized: true }; },
    };
  const indexer = createFinalizedEscrowIndexer({
    db,
    source: { scan: async () => items },
    expected: { cluster: 'devnet', genesisHash: 'devnet-genesis', programId: PROGRAM_ID },
    clock: () => NOW,
  });
  return { indexer, writes, cursors };
}

describe('finalized escrow indexer', () => {
  it('projects finalized events and advances the durable cursor afterward', async () => {
    // Given a finalized transaction with two economic events
    const fixture = setup([transaction()]);

    // When the indexer consumes the page
    const result = await fixture.indexer.runOnce({ slot: 0n, signature: null }, 100);

    // Then both 0024 facades commit before one finalized cursor advancement
    expect(result).toEqual({ cursor: { slot: 42n, signature: 'signature-a' }, transactions: 1, events: 2, duplicates: 0 });
    expect(fixture.writes).toEqual(['market:signature-a:0', 'position:signature-a:1']);
    expect(fixture.cursors).toHaveLength(1);
    expect(fixture.cursors[0]).toMatchObject({ commitment: 'finalized', slot: 42n, signature: 'signature-a' });
  });

  it('safely replays duplicate delivery after restart', async () => {
    // Given the same finalized transaction delivered before and after restart
    const item = transaction();
    const fixture = setup([item]);
    await fixture.indexer.runOnce({ slot: 0n, signature: null }, 100);

    // When the persisted cursor page is replayed
    const result = await fixture.indexer.runOnce({ slot: 0n, signature: null }, 100);

    // Then chain identities dedupe every effect while the cursor remains recoverable
    expect(result.duplicates).toBe(2);
    expect(result.cursor).toEqual({ slot: 42n, signature: 'signature-a' });
  });

  it.each([
    { field: 'programId', value: '11111111111111111111111111111111' },
    { field: 'genesisHash', value: 'wrong-network' },
  ] as const)('rejects a finalized page with the wrong $field', async ({ field, value }) => {
    // Given finalized data outside the configured chain domain
    const bad = { ...transaction(), [field]: value };
    const fixture = setup([bad]);

    // When indexing runs, then no cursor can skip the invalid transaction
    await expect(fixture.indexer.runOnce({ slot: 0n, signature: null }, 100))
      .rejects.toBeInstanceOf(EscrowFinalizedIndexerError);
    expect(fixture.cursors).toHaveLength(0);
  });
});
