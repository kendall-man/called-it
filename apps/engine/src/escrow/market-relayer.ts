import type { EscrowRelayerJobRow } from '@calledit/db';
import { base58Decode } from '@calledit/solana';
import {
  buildUnsignedV0Transaction,
  bytesToHex,
  deriveMarketPda,
  deriveOracleSetPda,
  deriveProtocolConfigPda,
  deriveSolVaultPda,
  deriveUsdcVaultAddress,
  hashMarketDocumentV1,
  hexToBytes,
  materializeInstruction,
  type MarketDocumentV1,
} from '@calledit/escrow-sdk';
import { PublicKey, type Signer } from '@solana/web3.js';
import { z } from 'zod';
import type {
  EscrowRelayerPreparedTransaction,
  EscrowRelayerTransactionBuilder,
} from './relayer-worker.js';
import { sponsorTransaction } from './transaction-signatures.js';

export interface EscrowMarketInitializationObservation {
  readonly genesisHash: string;
  readonly programExecutable: boolean;
  readonly programId: string;
  readonly configPda: string;
  readonly configOwnerProgramId: string;
  readonly paused: boolean;
  readonly configGenesisHashHex: string;
  readonly canonicalUsdcMint: string;
  readonly marketCreationAuthority: string;
  readonly relayerFeePayer: string;
  readonly oracleSetPda: string;
  readonly oracleOwnerProgramId: string;
  readonly oracleSetEpoch: bigint;
  readonly marketExists: boolean;
}

export interface EscrowMarketRelayerChain {
  inspectInitialization(input: {
    readonly genesisHash: string;
    readonly programId: string;
    readonly protocolConfigPda: string;
    readonly oracleSetPda: string;
    readonly marketPda: string;
    readonly vaultPda: string;
  }): Promise<EscrowMarketInitializationObservation>;
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
}

export interface EscrowMarketRelayerExpectation {
  readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
  readonly genesisHash: string;
  readonly programId: string;
  readonly protocolConfigPda: string;
  readonly oracleSetPda: string;
  readonly oracleSetEpoch: bigint;
  readonly canonicalUsdcMint: string;
  readonly marketCreationAuthority: string;
  readonly relayerFeePayer: string;
}

export class EscrowMarketRelayerError extends Error {
  readonly name = 'EscrowMarketRelayerError';

  constructor(readonly code: 'invalid_payload' | 'identity_mismatch' | 'rpc_state_mismatch' | 'market_already_exists') {
    super(`escrow market relay rejected: ${code}`);
  }
}

const payloadSchema = z.object({
  schemaVersion: z.literal(1), cluster: z.enum(['localnet', 'devnet', 'mainnet-beta']),
  genesisHash: z.string().min(1), clusterGenesisHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  programId: z.string().min(1), protocolConfigPda: z.string().min(1), oracleSetPda: z.string().min(1),
  marketCreationAuthority: z.string().min(1), relayerFeePayer: z.string().min(1), canonicalUsdcMint: z.string().min(1),
  marketUuid: z.string().min(1), fixtureId: z.string().regex(/^\d+$/),
  claimSpecificationHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  displayTermsHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  asset: z.enum(['sol', 'usdc']), probabilityPpm: z.number().int(), ratioMilli: z.number().int(),
  oddsMessageHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/), oddsTimestamp: z.string().regex(/^-?\d+$/),
  inPlayStartTimestamp: z.string().regex(/^-?\d+$/), activationDelaySeconds: z.string().regex(/^\d+$/),
  positionCutoff: z.string().regex(/^-?\d+$/), resolutionDeadline: z.string().regex(/^-?\d+$/),
  feeBps: z.number().int(), oracleSetEpoch: z.string().regex(/^\d+$/), replayFlag: z.boolean(),
  documentHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/), marketPda: z.string().min(1), vaultPda: z.string().min(1),
}).passthrough();

type MarketPayload = z.infer<typeof payloadSchema>;

function parsePayload(job: EscrowRelayerJobRow): MarketPayload {
  const result = payloadSchema.safeParse(job.payload);
  if (
    !result.success || job.kind !== 'market_initialization' ||
    job.marketId !== result.data.marketUuid || job.cluster !== result.data.cluster ||
    job.custodyMode !== 'escrow'
  ) {
    throw new EscrowMarketRelayerError('invalid_payload');
  }
  return result.data;
}

function document(payload: MarketPayload): MarketDocumentV1 {
  return {
    marketUuid: payload.marketUuid, fixtureId: BigInt(payload.fixtureId),
    claimSpecificationHash: hexToBytes(payload.claimSpecificationHashHex),
    displayTermsHash: hexToBytes(payload.displayTermsHashHex), asset: payload.asset,
    probabilityPpm: payload.probabilityPpm, ratioMilli: payload.ratioMilli,
    oddsMessageHash: hexToBytes(payload.oddsMessageHashHex), oddsTimestamp: BigInt(payload.oddsTimestamp),
    inPlayStartTimestamp: BigInt(payload.inPlayStartTimestamp),
    activationDelaySeconds: BigInt(payload.activationDelaySeconds),
    positionCutoff: BigInt(payload.positionCutoff), resolutionDeadline: BigInt(payload.resolutionDeadline),
    feeBps: payload.feeBps, oracleSetEpoch: BigInt(payload.oracleSetEpoch), replayFlag: payload.replayFlag,
  };
}

function matchesExpected(payload: MarketPayload, expected: EscrowMarketRelayerExpectation): boolean {
  return payload.cluster === expected.cluster && payload.genesisHash === expected.genesisHash &&
    payload.programId === expected.programId && payload.protocolConfigPda === expected.protocolConfigPda &&
    payload.oracleSetPda === expected.oracleSetPda && BigInt(payload.oracleSetEpoch) === expected.oracleSetEpoch &&
    payload.canonicalUsdcMint === expected.canonicalUsdcMint &&
    payload.marketCreationAuthority === expected.marketCreationAuthority && payload.relayerFeePayer === expected.relayerFeePayer;
}

function verifyDerivedIdentities(payload: MarketPayload, value: MarketDocumentV1): void {
  const genesis = base58Decode(payload.genesisHash);
  const market = deriveMarketPda(payload.programId, payload.marketUuid);
  const config = deriveProtocolConfigPda(payload.programId);
  const oracle = deriveOracleSetPda(payload.programId, value.oracleSetEpoch);
  const vault = value.asset === 'sol'
    ? deriveSolVaultPda(payload.programId, market.publicKey).address
    : deriveUsdcVaultAddress(market.publicKey, payload.canonicalUsdcMint).toBase58();
  if (
    genesis.length !== 32 || bytesToHex(genesis) !== payload.clusterGenesisHashHex.toLowerCase() ||
    market.address !== payload.marketPda || config.address !== payload.protocolConfigPda ||
    oracle.address !== payload.oracleSetPda || vault !== payload.vaultPda ||
    bytesToHex(hashMarketDocumentV1(value)) !== payload.documentHashHex.toLowerCase()
  ) throw new EscrowMarketRelayerError('identity_mismatch');
}

function verifyObservation(payload: MarketPayload, observed: EscrowMarketInitializationObservation): void {
  if (observed.marketExists) throw new EscrowMarketRelayerError('market_already_exists');
  if (
    observed.genesisHash !== payload.genesisHash || !observed.programExecutable || observed.programId !== payload.programId ||
    observed.configPda !== payload.protocolConfigPda || observed.configOwnerProgramId !== payload.programId || observed.paused ||
    observed.configGenesisHashHex.toLowerCase() !== payload.clusterGenesisHashHex.toLowerCase() ||
    observed.canonicalUsdcMint !== payload.canonicalUsdcMint ||
    observed.marketCreationAuthority !== payload.marketCreationAuthority || observed.relayerFeePayer !== payload.relayerFeePayer ||
    observed.oracleSetPda !== payload.oracleSetPda || observed.oracleOwnerProgramId !== payload.programId ||
    observed.oracleSetEpoch !== BigInt(payload.oracleSetEpoch)
  ) throw new EscrowMarketRelayerError('rpc_state_mismatch');
}

export function createMarketInitializationTransactionBuilder(options: {
  readonly chain: EscrowMarketRelayerChain;
  readonly sponsor: Signer;
  readonly marketCreationAuthority: Signer;
  readonly expected: EscrowMarketRelayerExpectation;
}): EscrowRelayerTransactionBuilder {
  return {
    async build(job): Promise<EscrowRelayerPreparedTransaction> {
      const payload = parsePayload(job);
      if (!matchesExpected(payload, options.expected) || job.programId !== payload.programId ||
        !options.sponsor.publicKey.equals(new PublicKey(payload.relayerFeePayer)) ||
        !options.marketCreationAuthority.publicKey.equals(new PublicKey(payload.marketCreationAuthority))) {
        throw new EscrowMarketRelayerError('identity_mismatch');
      }
      const marketDocument = document(payload);
      verifyDerivedIdentities(payload, marketDocument);
      const observed = await options.chain.inspectInitialization({
        genesisHash: payload.genesisHash, programId: payload.programId, protocolConfigPda: payload.protocolConfigPda,
        oracleSetPda: payload.oracleSetPda, marketPda: payload.marketPda, vaultPda: payload.vaultPda,
      });
      verifyObservation(payload, observed);
      const blockhash = await options.chain.latestBlockhash();
      const instruction = materializeInstruction({
        kind: 'initialize_market', payer: options.sponsor.publicKey,
        marketCreationAuthority: options.marketCreationAuthority.publicKey,
        canonicalUsdcMint: payload.canonicalUsdcMint,
        expectedClusterGenesisHash: hexToBytes(payload.clusterGenesisHashHex),
        document: marketDocument,
        documentHash: hexToBytes(payload.documentHashHex),
      }, { programId: new PublicKey(payload.programId) });
      const transaction = buildUnsignedV0Transaction({
        feePayer: options.sponsor.publicKey, recentBlockhash: blockhash.blockhash, instructions: [instruction],
      });
      const sponsored = sponsorTransaction(transaction, options.sponsor);
      if (!options.marketCreationAuthority.publicKey.equals(options.sponsor.publicKey)) {
        transaction.sign([options.marketCreationAuthority]);
      }
      return {
        rawTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
        expectedSignature: sponsored.expectedSignature,
        transactionMessageHashHex: sponsored.messageHashHex,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      };
    },
  };
}
