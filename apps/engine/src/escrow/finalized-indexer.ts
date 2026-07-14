import type {
  EscrowAsset,
  EscrowClaimEventInput,
  EscrowCluster,
  EscrowDb,
  EscrowPositionEventInput,
  EscrowSettlementEventInput,
} from '@calledit/db';

export interface EscrowFinalizedCursor {
  readonly slot: bigint;
  readonly signature: string | null;
}

export type EscrowFinalizedProjection =
  | {
      readonly kind: 'market';
      readonly marketId: string;
      readonly custodyVersion: number;
      readonly marketPda: string;
      readonly vaultPda: string;
      readonly asset: EscrowAsset;
      readonly mintPubkey: string | null;
      readonly documentHashHex: string;
      readonly oracleEpoch: bigint;
      readonly eventEpoch: bigint;
      readonly ratioMilli: bigint;
    }
  | ({ readonly kind: 'position' } & Omit<
      EscrowPositionEventInput,
      'signature' | 'instructionIndex' | 'programId' | 'slot' | 'blockTimeIso' | 'commitment' | 'observedAtIso'
    >)
  | ({ readonly kind: 'settlement' } & Omit<
      EscrowSettlementEventInput,
      'signature' | 'instructionIndex' | 'programId' | 'slot' | 'blockTimeIso' | 'commitment' | 'observedAtIso'
    >)
  | ({ readonly kind: 'claim' } & Omit<
      EscrowClaimEventInput,
      'signature' | 'instructionIndex' | 'programId' | 'slot' | 'blockTimeIso' | 'commitment' | 'observedAtIso'
    >);

export interface EscrowFinalizedEvent {
  readonly instructionIndex: number;
  readonly projection: EscrowFinalizedProjection;
}

export interface EscrowFinalizedTransaction {
  readonly signature: string;
  readonly slot: bigint;
  readonly blockTimeIso: string | null;
  readonly genesisHash: string;
  readonly programId: string;
  readonly events: readonly EscrowFinalizedEvent[];
}

export interface EscrowFinalizedEventSource {
  scan(cursor: EscrowFinalizedCursor, limit: number): Promise<readonly EscrowFinalizedTransaction[]>;
}

export class EscrowFinalizedIndexerError extends Error {
  readonly name = 'EscrowFinalizedIndexerError';

  constructor(readonly code: 'invalid_page' | 'chain_identity_mismatch' | 'cursor_regression') {
    super(`escrow finalized indexer rejected: ${code}`);
  }
}

type IndexDb = Pick<
  EscrowDb,
  'upsertMarketLink' | 'recordPositionEvent' | 'recordSettlementEvent' |
  'recordClaimEvent' | 'advanceChainCursor'
>;

async function project(
  db: IndexDb,
  transaction: EscrowFinalizedTransaction,
  event: EscrowFinalizedEvent,
  expected: { readonly cluster: EscrowCluster; readonly genesisHash: string; readonly programId: string },
  observedAtIso: string,
): Promise<boolean> {
  const common = {
    signature: transaction.signature,
    instructionIndex: event.instructionIndex,
    programId: expected.programId,
    slot: transaction.slot,
    blockTimeIso: transaction.blockTimeIso,
    commitment: 'finalized' as const,
    observedAtIso,
  };
  switch (event.projection.kind) {
    case 'market': {
      const result = await db.upsertMarketLink({
        marketId: event.projection.marketId,
        custodyMode: 'escrow',
        custodyVersion: event.projection.custodyVersion,
        cluster: expected.cluster,
        genesisHash: expected.genesisHash,
        programId: expected.programId,
        marketPda: event.projection.marketPda,
        vaultPda: event.projection.vaultPda,
        asset: event.projection.asset,
        mintPubkey: event.projection.mintPubkey,
        documentHashHex: event.projection.documentHashHex,
        initializeSignature: transaction.signature,
        initializeInstructionIndex: event.instructionIndex,
        initializeSlot: transaction.slot,
        initializeBlockTimeIso: transaction.blockTimeIso,
        oracleEpoch: event.projection.oracleEpoch,
        eventEpoch: event.projection.eventEpoch,
        ratioMilli: event.projection.ratioMilli,
        commitment: 'finalized',
        observedAtIso,
      });
      return result.duplicate;
    }
    case 'position': {
      const { kind: _, ...value } = event.projection;
      return (await db.recordPositionEvent({ ...value, ...common })).duplicate;
    }
    case 'settlement': {
      const { kind: _, ...value } = event.projection;
      return (await db.recordSettlementEvent({ ...value, ...common })).duplicate;
    }
    case 'claim': {
      const { kind: _, ...value } = event.projection;
      return (await db.recordClaimEvent({ ...value, ...common })).duplicate;
    }
  }
}

export function createFinalizedEscrowIndexer(options: {
  readonly db: IndexDb;
  readonly source: EscrowFinalizedEventSource;
  readonly expected: { readonly cluster: EscrowCluster; readonly genesisHash: string; readonly programId: string };
  readonly clock: () => string;
}): {
  runOnce(cursor: EscrowFinalizedCursor, limit: number): Promise<{
    readonly cursor: EscrowFinalizedCursor;
    readonly transactions: number;
    readonly events: number;
    readonly duplicates: number;
  }>;
} {
  return {
    async runOnce(cursor, limit) {
      if (cursor.slot < 0n || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new EscrowFinalizedIndexerError('invalid_page');
      }
      const transactions = await options.source.scan(cursor, limit);
      let nextCursor = cursor;
      let eventCount = 0;
      let duplicates = 0;
      for (const transaction of transactions) {
        if (
          transaction.genesisHash !== options.expected.genesisHash ||
          transaction.programId !== options.expected.programId
        ) throw new EscrowFinalizedIndexerError('chain_identity_mismatch');
        if (transaction.slot < nextCursor.slot) {
          throw new EscrowFinalizedIndexerError('cursor_regression');
        }
        const indexes = new Set<number>();
        for (const event of transaction.events) {
          if (!Number.isSafeInteger(event.instructionIndex) || event.instructionIndex < 0 || indexes.has(event.instructionIndex)) {
            throw new EscrowFinalizedIndexerError('invalid_page');
          }
          indexes.add(event.instructionIndex);
          if (await project(options.db, transaction, event, options.expected, options.clock())) duplicates += 1;
          eventCount += 1;
        }
        await options.db.advanceChainCursor({
          cluster: options.expected.cluster,
          genesisHash: options.expected.genesisHash,
          programId: options.expected.programId,
          commitment: 'finalized',
          slot: transaction.slot,
          signature: transaction.signature,
          nowIso: options.clock(),
        });
        nextCursor = { slot: transaction.slot, signature: transaction.signature };
      }
      return { cursor: nextCursor, transactions: transactions.length, events: eventCount, duplicates };
    },
  };
}
