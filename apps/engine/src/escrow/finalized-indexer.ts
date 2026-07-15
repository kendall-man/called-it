import type {
  EscrowAsset,
  EscrowClaimEventInput,
  EscrowCluster,
  EscrowDb,
  EscrowMarketClosedInput,
  EscrowPositionEventInput,
  EscrowSettlementEventInput,
} from '@calledit/db';
import type { EscrowFinalizedPointsProjection } from './points-projection.js';

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
    >)
  | {
      readonly kind: 'market_closed';
      readonly marketId: string;
      readonly marketPda: string;
      readonly documentHashHex: string;
      readonly asset: EscrowAsset;
      readonly dustAmountAtomic: bigint;
    }
  | {
      readonly kind: 'market_state';
      readonly marketId: string;
      readonly state: 'open' | 'frozen';
      readonly eventEpoch: bigint;
      readonly evidenceHashHex: string;
    };

export interface EscrowFinalizedEvent {
  readonly instructionIndex: number;
  readonly projection: EscrowFinalizedProjection | {
    resolve(): Promise<EscrowFinalizedProjection | null>;
  };
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
  scan(cursor: EscrowFinalizedCursor, limit: number): Promise<{
    readonly transactions: readonly EscrowFinalizedTransaction[];
    readonly scannedThroughSlot: bigint;
  }>;
}

export interface EscrowFinalizedScanWatermark {
  readonly slot: bigint;
  readonly scannedAtIso: string;
}

export interface EscrowFinalizedTransactionProjection {
  readonly signature: string;
  readonly slot: bigint;
  readonly blockTimeIso: string | null;
  readonly projections: readonly EscrowFinalizedProjection[];
}

export class EscrowFinalizedIndexerError extends Error {
  readonly name = 'EscrowFinalizedIndexerError';

  constructor(readonly code: 'invalid_page' | 'chain_identity_mismatch' | 'cursor_regression' | 'cursor_unavailable' | 'projection_unavailable') {
    super(`escrow finalized indexer rejected: ${code}`);
  }
}

export type EscrowFinalizedChainCursorResult =
  | {
      readonly ok: true;
      readonly initialized: boolean;
      readonly cluster: EscrowCluster;
      readonly genesisHash: string;
      readonly programId: string;
      readonly confirmedSlot: bigint;
      readonly confirmedSignature: string | null;
      readonly finalizedSlot: bigint;
      readonly finalizedSignature: string | null;
      readonly updatedAtIso: string | null;
    }
  | { readonly ok: false; readonly code: 'invalid_input' | 'genesis_mismatch' };

export interface EscrowFinalizedIndexDb extends Pick<
  EscrowDb,
  'upsertMarketLink' | 'recordPositionEvent' | 'recordSettlementEvent' |
  'recordClaimEvent' | 'advanceChainCursor'
> {
  getChainCursor(input: {
    readonly cluster: EscrowCluster;
    readonly genesisHash: string;
    readonly programId: string;
  }): Promise<EscrowFinalizedChainCursorResult>;
  recordMarketClosed(input: EscrowMarketClosedInput): Promise<{
    readonly ok: true;
    readonly duplicate: boolean;
    readonly finalized: boolean;
  }>;
}

async function project(
  db: EscrowFinalizedIndexDb,
  transaction: EscrowFinalizedTransaction,
  instructionIndex: number,
  projection: EscrowFinalizedProjection,
  expected: { readonly cluster: EscrowCluster; readonly genesisHash: string; readonly programId: string },
  observedAtIso: string,
): Promise<boolean> {
  const common = {
    signature: transaction.signature,
    instructionIndex,
    programId: expected.programId,
    slot: transaction.slot,
    blockTimeIso: transaction.blockTimeIso,
    commitment: 'finalized' as const,
    observedAtIso,
  };
  switch (projection.kind) {
    case 'market': {
      const result = await db.upsertMarketLink({
        marketId: projection.marketId,
        custodyMode: 'escrow',
        custodyVersion: projection.custodyVersion,
        cluster: expected.cluster,
        genesisHash: expected.genesisHash,
        programId: expected.programId,
        marketPda: projection.marketPda,
        vaultPda: projection.vaultPda,
        asset: projection.asset,
        mintPubkey: projection.mintPubkey,
        documentHashHex: projection.documentHashHex,
        initializeSignature: transaction.signature,
        initializeInstructionIndex: instructionIndex,
        initializeSlot: transaction.slot,
        initializeBlockTimeIso: transaction.blockTimeIso,
        oracleEpoch: projection.oracleEpoch,
        eventEpoch: projection.eventEpoch,
        ratioMilli: projection.ratioMilli,
        commitment: 'finalized',
        observedAtIso,
      });
      return result.duplicate;
    }
    case 'position': {
      const { kind: _, ...value } = projection;
      return (await db.recordPositionEvent({ ...value, ...common })).duplicate;
    }
    case 'settlement': {
      const { kind: _, ...value } = projection;
      return (await db.recordSettlementEvent({ ...value, ...common })).duplicate;
    }
    case 'claim': {
      const { kind: _, ...value } = projection;
      return (await db.recordClaimEvent({ ...value, ...common })).duplicate;
    }
    case 'market_closed': {
      const { kind: _, ...value } = projection;
      return (await db.recordMarketClosed({
        ...value,
        ...common,
        cluster: expected.cluster,
        genesisHash: expected.genesisHash,
      })).duplicate;
    }
    case 'market_state':
      return false;
  }
}

async function resolveProjection(
  event: EscrowFinalizedEvent,
): Promise<EscrowFinalizedProjection | null> {
  return 'resolve' in event.projection ? event.projection.resolve() : event.projection;
}

export function createFinalizedEscrowIndexer(options: {
  readonly db: EscrowFinalizedIndexDb;
  readonly source: EscrowFinalizedEventSource;
  readonly expected: { readonly cluster: EscrowCluster; readonly genesisHash: string; readonly programId: string };
  readonly clock: () => string;
  readonly points: EscrowFinalizedPointsProjection;
  readonly afterTransaction?: (transaction: EscrowFinalizedTransactionProjection) => Promise<void>;
}): {
  runOnce(limit: number): Promise<{
    readonly cursor: EscrowFinalizedCursor;
    readonly transactions: number;
    readonly events: number;
    readonly duplicates: number;
  }>;
  scanWatermark(): EscrowFinalizedScanWatermark | null;
} {
  let scanWatermark: EscrowFinalizedScanWatermark | null = null;
  return {
    async runOnce(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new EscrowFinalizedIndexerError('invalid_page');
      }
      const stored = await options.db.getChainCursor(options.expected);
      if (!stored.ok) throw new EscrowFinalizedIndexerError('cursor_unavailable');
      if (
        stored.cluster !== options.expected.cluster ||
        stored.genesisHash !== options.expected.genesisHash ||
        stored.programId !== options.expected.programId
      ) throw new EscrowFinalizedIndexerError('chain_identity_mismatch');
      const cursor: EscrowFinalizedCursor = stored.initialized
        ? { slot: stored.finalizedSlot, signature: stored.finalizedSignature }
        : { slot: 0n, signature: null };
      if (cursor.slot < 0n || (cursor.slot > 0n && cursor.signature === null)) {
        throw new EscrowFinalizedIndexerError('cursor_unavailable');
      }
      const scan = await options.source.scan(cursor, limit);
      const { transactions } = scan;
      let pageSlot = cursor.slot;
      for (const transaction of transactions) {
        if (
          transaction.genesisHash !== options.expected.genesisHash ||
          transaction.programId !== options.expected.programId
        ) throw new EscrowFinalizedIndexerError('chain_identity_mismatch');
        if (transaction.slot < pageSlot) throw new EscrowFinalizedIndexerError('cursor_regression');
        pageSlot = transaction.slot;
      }
      if (scan.scannedThroughSlot < pageSlot) {
        throw new EscrowFinalizedIndexerError('cursor_regression');
      }
      let nextCursor = cursor;
      let eventCount = 0;
      let duplicates = 0;
      for (const transaction of transactions) {
        const indexes = new Set<number>();
        const resolvedProjections: EscrowFinalizedProjection[] = [];
        const economicProjections: Array<{
          readonly instructionIndex: number;
          readonly projection: Extract<EscrowFinalizedProjection, { kind: 'settlement' | 'claim' }>;
        }> = [];
        for (const event of transaction.events) {
          if (!Number.isSafeInteger(event.instructionIndex) || event.instructionIndex < 0 || indexes.has(event.instructionIndex)) {
            throw new EscrowFinalizedIndexerError('invalid_page');
          }
          indexes.add(event.instructionIndex);
          const projection = await resolveProjection(event);
          if (projection === null) continue;
          resolvedProjections.push(projection);
          if (await project(
            options.db,
            transaction,
            event.instructionIndex,
            projection,
            options.expected,
            options.clock(),
          )) duplicates += 1;
          if (projection.kind === 'settlement' || projection.kind === 'claim') {
            economicProjections.push({ instructionIndex: event.instructionIndex, projection });
          }
          eventCount += 1;
        }
        await options.afterTransaction?.({
          signature: transaction.signature,
          slot: transaction.slot,
          blockTimeIso: transaction.blockTimeIso,
          projections: resolvedProjections,
        });
        for (const economic of economicProjections) {
          await options.points.afterEconomicProjection({
            marketId: economic.projection.marketId,
            kind: economic.projection.kind,
            signature: transaction.signature,
            instructionIndex: economic.instructionIndex,
          });
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
      scanWatermark = {
        slot: scan.scannedThroughSlot,
        scannedAtIso: options.clock(),
      };
      return { cursor: nextCursor, transactions: transactions.length, events: eventCount, duplicates };
    },
    scanWatermark() {
      return scanWatermark;
    },
  };
}
