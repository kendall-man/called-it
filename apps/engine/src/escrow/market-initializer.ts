import type { EscrowDb } from '@calledit/db';
import { base58Decode, bytesToHex } from '@calledit/solana';
import {
  deriveMarketPda,
  deriveOracleSetPda,
  deriveProtocolConfigPda,
  deriveSolVaultPda,
  deriveUsdcVaultAddress,
  type EscrowAsset,
  type MarketState,
} from '@calledit/escrow-sdk';
import { createEscrowJobIdempotencyKey } from './job-state.js';
import {
  buildImmutableMarketDocument,
  type ImmutableMarketDocumentInput,
} from './market-document.js';
import type { EscrowReadinessReport } from './readiness.js';

export interface EscrowMarketChainRecord {
  readonly ownerProgramId: string;
  readonly marketPda: string;
  readonly vaultPda: string;
  readonly documentHashHex: string;
  readonly asset: EscrowAsset;
  readonly tokenMint: string | null;
  readonly oracleSetEpoch: bigint;
  readonly ratioMilli: number;
  readonly state: MarketState;
}

export interface EscrowMarketInitializationChain {
  readMarket(marketPda: string): Promise<EscrowMarketChainRecord | null>;
}

export interface EscrowMarketDeployment {
  readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
  readonly genesisHash: string;
  readonly programId: string;
  readonly canonicalUsdcMint: string;
  readonly marketCreationAuthority: string;
  readonly relayerFeePayer: string;
  readonly oracleSetEpoch: bigint;
  readonly custodyVersion: number;
}

export interface InitializeEscrowMarketInput {
  readonly document: ImmutableMarketDocumentInput;
  readonly nowIso: string;
  readonly maxAttempts: number;
}

export type InitializeEscrowMarketResult =
  | { readonly kind: 'blocked'; readonly reasons: EscrowReadinessReport['reasons'] }
  | {
      readonly kind: 'queued';
      readonly created: boolean;
      readonly marketPda: string;
      readonly vaultPda: string;
      readonly documentHashHex: string;
    }
  | {
      readonly kind: 'initialized';
      readonly marketPda: string;
      readonly vaultPda: string;
      readonly documentHashHex: string;
      readonly state: MarketState;
    };

export class EscrowMarketInitializationError extends Error {
  readonly name = 'EscrowMarketInitializationError';

  constructor(
    readonly code:
      | 'invalid_genesis_hash'
      | 'oracle_epoch_mismatch'
      | 'chain_account_mismatch'
      | 'durable_enqueue_rejected',
  ) {
    super(`escrow market initialization failed: ${code}`);
  }
}

function expectedMint(asset: EscrowAsset, canonicalUsdcMint: string): string | null {
  return asset === 'usdc' ? canonicalUsdcMint : null;
}

function chainRecordMatches(
  observed: EscrowMarketChainRecord,
  expected: Omit<EscrowMarketChainRecord, 'state'>,
): boolean {
  return (
    observed.ownerProgramId === expected.ownerProgramId &&
    observed.marketPda === expected.marketPda &&
    observed.vaultPda === expected.vaultPda &&
    observed.documentHashHex.toLowerCase() === expected.documentHashHex &&
    observed.asset === expected.asset &&
    observed.tokenMint === expected.tokenMint &&
    observed.oracleSetEpoch === expected.oracleSetEpoch &&
    observed.ratioMilli === expected.ratioMilli
  );
}

function documentPayload(input: {
  readonly immutable: ReturnType<typeof buildImmutableMarketDocument>;
  readonly deployment: EscrowMarketDeployment;
  readonly marketPda: string;
  readonly vaultPda: string;
}): Readonly<Record<string, unknown>> {
  const document = input.immutable.document;
  const genesisHashBytes = base58Decode(input.deployment.genesisHash);
  if (genesisHashBytes.length !== 32) {
    throw new EscrowMarketInitializationError('invalid_genesis_hash');
  }
  return {
    schemaVersion: 1,
    cluster: input.deployment.cluster,
    genesisHash: input.deployment.genesisHash,
    clusterGenesisHashHex: bytesToHex(genesisHashBytes),
    programId: input.deployment.programId,
    protocolConfigPda: deriveProtocolConfigPda(input.deployment.programId).address,
    oracleSetPda: deriveOracleSetPda(
      input.deployment.programId,
      input.deployment.oracleSetEpoch,
    ).address,
    marketUuid: document.marketUuid,
    fixtureId: String(document.fixtureId),
    claimSpecificationHashHex: input.immutable.claimSpecificationHashHex,
    displayTermsHashHex: input.immutable.displayTermsHashHex,
    asset: document.asset,
    canonicalUsdcMint: input.deployment.canonicalUsdcMint,
    marketCreationAuthority: input.deployment.marketCreationAuthority,
    relayerFeePayer: input.deployment.relayerFeePayer,
    probabilityPpm: document.probabilityPpm,
    ratioMilli: document.ratioMilli,
    oddsMessageHashHex: input.immutable.oddsMessageHashHex,
    oddsTimestamp: String(document.oddsTimestamp),
    inPlayStartTimestamp: String(document.inPlayStartTimestamp),
    activationDelaySeconds: String(document.activationDelaySeconds),
    positionCutoff: String(document.positionCutoff),
    resolutionDeadline: String(document.resolutionDeadline),
    feeBps: document.feeBps,
    oracleSetEpoch: String(document.oracleSetEpoch),
    replayFlag: document.replayFlag,
    documentHashHex: input.immutable.documentHashHex,
    marketPda: input.marketPda,
    vaultPda: input.vaultPda,
  };
}

export function createMarketInitializationService(options: {
  readonly db: Pick<EscrowDb, 'enqueueRelayerJob'>;
  readonly deployment: EscrowMarketDeployment;
  readonly chain: EscrowMarketInitializationChain;
  readonly readiness: () => Promise<EscrowReadinessReport>;
}): { initialize(input: InitializeEscrowMarketInput): Promise<InitializeEscrowMarketResult> } {
  return {
    async initialize(input) {
      const readiness = await options.readiness();
      if (readiness.status === 'not_ready') {
        return { kind: 'blocked', reasons: readiness.reasons };
      }
      if (input.document.oracleSetEpoch !== options.deployment.oracleSetEpoch) {
        throw new EscrowMarketInitializationError('oracle_epoch_mismatch');
      }

      const immutable = buildImmutableMarketDocument(input.document);
      const market = deriveMarketPda(options.deployment.programId, input.document.marketId);
      const vaultPda = input.document.asset === 'sol'
        ? deriveSolVaultPda(options.deployment.programId, market.publicKey).address
        : deriveUsdcVaultAddress(market.publicKey, options.deployment.canonicalUsdcMint).toBase58();
      const expected: Omit<EscrowMarketChainRecord, 'state'> = {
        ownerProgramId: options.deployment.programId,
        marketPda: market.address,
        vaultPda,
        documentHashHex: immutable.documentHashHex,
        asset: input.document.asset,
        tokenMint: expectedMint(input.document.asset, options.deployment.canonicalUsdcMint),
        oracleSetEpoch: input.document.oracleSetEpoch,
        ratioMilli: immutable.document.ratioMilli,
      };
      const observed = await options.chain.readMarket(market.address);
      if (observed !== null) {
        if (!chainRecordMatches(observed, expected)) {
          throw new EscrowMarketInitializationError('chain_account_mismatch');
        }
        return {
          kind: 'initialized',
          marketPda: market.address,
          vaultPda,
          documentHashHex: immutable.documentHashHex,
          state: observed.state,
        };
      }

      const enqueued = await options.db.enqueueRelayerJob({
        kind: 'market_initialization',
        idempotencyKey: createEscrowJobIdempotencyKey({
          kind: 'market_initialization',
          programId: options.deployment.programId,
          marketPda: market.address,
        }),
        cluster: options.deployment.cluster,
        programId: options.deployment.programId,
        custodyMode: 'escrow',
        custodyVersion: options.deployment.custodyVersion,
        marketId: input.document.marketId,
        ownerPubkey: null,
        payload: documentPayload({ immutable, deployment: options.deployment, marketPda: market.address, vaultPda }),
        dueAtIso: input.nowIso,
        maxAttempts: input.maxAttempts,
        nowIso: input.nowIso,
      });
      if (!enqueued.ok || !('created' in enqueued)) {
        throw new EscrowMarketInitializationError('durable_enqueue_rejected');
      }
      return {
        kind: 'queued',
        created: enqueued.created,
        marketPda: market.address,
        vaultPda,
        documentHashHex: immutable.documentHashHex,
      };
    },
  };
}
