import type { EscrowDb } from '@calledit/db';
import { describe, expect, it } from 'vitest';
import {
  createFinalizedEscrowIndexer,
  EscrowFinalizedIndexerError,
  type EscrowFinalizedCursor,
  type EscrowFinalizedIndexDb,
  type EscrowFinalizedTransaction,
} from './finalized-indexer.js';
import {
  createEscrowFinalizedPointsProjection,
  createEscrowPrivatePointsParticipants,
} from './points-projection.js';

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

function setup(
  items: readonly EscrowFinalizedTransaction[],
  initialCursor: EscrowFinalizedCursor = { slot: 0n, signature: null },
) {
  const identities = new Set<string>();
  const writes: string[] = [];
  const cursors: Parameters<EscrowDb['advanceChainCursor']>[0][] = [];
  const scans: EscrowFinalizedCursor[] = [];
  const pointCalls: string[] = [];
  let persistedCursor = initialCursor;
  const result = (identity: string) => {
    const duplicate = identities.has(identity);
    identities.add(identity);
    return { ok: true as const, duplicate, finalized: true };
  };
  const db: EscrowFinalizedIndexDb = {
      async getChainCursor() {
        return {
          ok: true, initialized: persistedCursor.signature !== null,
          cluster: 'devnet', genesisHash: 'devnet-genesis', programId: PROGRAM_ID,
          confirmedSlot: persistedCursor.slot, confirmedSignature: persistedCursor.signature,
          finalizedSlot: persistedCursor.slot, finalizedSignature: persistedCursor.signature,
          updatedAtIso: persistedCursor.signature === null ? null : NOW,
        };
      },
      async upsertMarketLink(input) { writes.push(`market:${input.initializeSignature}:${input.initializeInstructionIndex}`); return result(writes.at(-1) ?? ''); },
      async recordPositionEvent(input) { writes.push(`position:${input.signature}:${input.instructionIndex}`); return result(writes.at(-1) ?? ''); },
      async recordSettlementEvent(input) { writes.push(`settlement:${input.signature}:${input.instructionIndex}`); return result(writes.at(-1) ?? ''); },
      async recordClaimEvent(input) { writes.push(`claim:${input.signature}:${input.instructionIndex}`); return result(writes.at(-1) ?? ''); },
      async recordMarketClosed(input) { writes.push(`close:${input.signature}:${input.instructionIndex}:${input.documentHashHex}`); return result(writes.at(-1) ?? ''); },
      async advanceChainCursor(input) {
        cursors.push(input);
        persistedCursor = { slot: input.slot, signature: input.signature };
        return { ok: true, duplicate: false, finalized: true };
      },
    };
  const indexer = createFinalizedEscrowIndexer({
    db,
    source: { scan: async (cursor) => { scans.push(cursor); return items; } },
    expected: { cluster: 'devnet', genesisHash: 'devnet-genesis', programId: PROGRAM_ID },
    clock: () => NOW,
    points: { async afterEconomicProjection(input) { pointCalls.push(input.marketId); return { kind: 'replay_skipped' }; } },
  });
  return { db, indexer, writes, cursors, scans, pointCalls, restart: () => createFinalizedEscrowIndexer({
    db,
    source: { scan: async (cursor) => { scans.push(cursor); return items; } },
    expected: { cluster: 'devnet', genesisHash: 'devnet-genesis', programId: PROGRAM_ID },
    clock: () => NOW,
    points: { async afterEconomicProjection(input) { pointCalls.push(input.marketId); return { kind: 'replay_skipped' }; } },
  }) };
}

describe('finalized escrow indexer', () => {
  it('projects finalized events and advances the durable cursor afterward', async () => {
    // Given a finalized transaction with two economic events
    const fixture = setup([transaction()], { slot: 12n, signature: 'signature-before' });

    // When the indexer consumes the page
    const result = await fixture.indexer.runOnce(100);

    // Then both 0024 facades commit before one finalized cursor advancement
    expect(result).toEqual({ cursor: { slot: 42n, signature: 'signature-a' }, transactions: 1, events: 2, duplicates: 0 });
    expect(fixture.writes).toEqual(['market:signature-a:0', 'position:signature-a:1']);
    expect(fixture.cursors).toHaveLength(1);
    expect(fixture.cursors[0]).toMatchObject({ commitment: 'finalized', slot: 42n, signature: 'signature-a' });
    expect(fixture.scans).toEqual([{ slot: 12n, signature: 'signature-before' }]);
  });

  it('safely replays duplicate delivery after restart', async () => {
    // Given the same finalized transaction delivered before and after restart
    const item = transaction();
    const fixture = setup([item]);
    await fixture.indexer.runOnce(100);

    // When the persisted cursor page is replayed
    const result = await fixture.restart().runOnce(100);

    // Then chain identities dedupe every effect while the cursor remains recoverable
    expect(result.duplicates).toBe(2);
    expect(result.cursor).toEqual({ slot: 42n, signature: 'signature-a' });
    expect(fixture.scans.at(-1)).toEqual({ slot: 42n, signature: 'signature-a' });
  });

  it.each([
    { field: 'programId', value: '11111111111111111111111111111111' },
    { field: 'genesisHash', value: 'wrong-network' },
  ] as const)('rejects a finalized page with the wrong $field', async ({ field, value }) => {
    // Given finalized data outside the configured chain domain
    const bad = { ...transaction(), [field]: value };
    const fixture = setup([bad]);

    // When indexing runs, then no cursor can skip the invalid transaction
    await expect(fixture.indexer.runOnce(100))
      .rejects.toBeInstanceOf(EscrowFinalizedIndexerError);
    expect(fixture.cursors).toHaveLength(0);
  });

  it('rejects reordered finalized transactions before advancing past them', async () => {
    const first = transaction();
    const reordered = { ...transaction(), signature: 'signature-b', slot: 41n };
    const fixture = setup([first, reordered]);

    await expect(fixture.indexer.runOnce(100)).rejects.toMatchObject({ code: 'cursor_regression' });
    expect(fixture.cursors).toHaveLength(0);
  });

  it('records exact MarketClosed identity before advancing the finalized cursor', async () => {
    const closed: EscrowFinalizedTransaction = {
      ...transaction(),
      events: [{
        instructionIndex: 0,
        projection: {
          kind: 'market_closed', marketId: MARKET_ID, marketPda: 'market-a',
          documentHashHex: 'ab'.repeat(32), asset: 'sol', dustAmountAtomic: 2n,
        },
      }],
    };
    const fixture = setup([closed]);

    await expect(fixture.indexer.runOnce(100)).resolves.toMatchObject({ events: 1 });
    expect(fixture.writes).toEqual([`close:signature-a:0:${'ab'.repeat(32)}`]);
    expect(fixture.cursors).toHaveLength(1);
  });

  it('projects receipt and Points before advancing a removed-group escrow settlement cursor', async () => {
    const settled: EscrowFinalizedTransaction = {
      ...transaction(),
      events: [{
        instructionIndex: 0,
        projection: {
          kind: 'settlement', marketId: MARKET_ID, outcome: 'claim_won',
          evidenceHashHex: 'cd'.repeat(32), documentHashHex: 'ab'.repeat(32), oracleEpoch: 9n,
        },
      }],
    };
    const fixture = setup([settled]);
    const order: string[] = [];
    let pointMutations = 0;
    const indexer = createFinalizedEscrowIndexer({
      db: fixture.db,
      source: { scan: async () => [settled] },
      expected: { cluster: 'devnet', genesisHash: 'devnet-genesis', programId: PROGRAM_ID },
      clock: () => NOW,
      points: createEscrowFinalizedPointsProjection({
        privateParticipants: createEscrowPrivatePointsParticipants({
          markets: {
            async getMarket() {
              return { custody_mode: 'escrow', is_replay: false };
            },
          },
        }),
        points: {
          async apply(marketId) {
            order.push('points');
            pointMutations += 1;
            return {
              eligible: true, duplicate: false, marketId, groupId: -1001,
              scoredCount: 1, winnerCount: 1, winners: [], misses: [], leaderboard: [],
            };
          },
        },
      }),
      async afterTransaction() { order.push('receipt'); },
    });

    await indexer.runOnce(100);

    expect(fixture.writes).toEqual(['settlement:signature-a:0']);
    expect(order).toEqual(['receipt', 'points']);
    expect(pointMutations).toBe(1);
    expect(fixture.cursors).toHaveLength(1);
  });

  it('does not advance the cursor when finalized presentation or reconciliation fails', async () => {
    const item = transaction();
    const fixture = setup([item]);
    const indexer = createFinalizedEscrowIndexer({
      db: fixture.db,
      source: { scan: async () => [item] },
      expected: { cluster: 'devnet', genesisHash: 'devnet-genesis', programId: PROGRAM_ID },
      clock: () => NOW,
      points: { async afterEconomicProjection() { return { kind: 'replay_skipped' }; } },
      async afterTransaction() { throw new Error('presentation unavailable'); },
    });

    await expect(indexer.runOnce(100)).rejects.toThrow('presentation unavailable');
    expect(fixture.cursors).toHaveLength(0);
  });
});
