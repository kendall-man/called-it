import {
  buildUnsignedV0Transaction,
  bytesToHex,
  deriveMarketPda,
  derivePositionLotPda,
  deriveProtocolConfigPda,
  deriveUserPositionPda,
  materializeInstruction,
  type MarketAccount,
  type PositionLotAccount,
  type ProtocolConfigAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import { base58Decode } from '@calledit/solana';
import { PublicKey, type Signer } from '@solana/web3.js';
import { z } from 'zod';
import type { EscrowPlacementMarketLinkResult } from './placement-types.js';
import type {
  DurableEscrowRelayerJobRow,
  EscrowRelayerFinalityVerifier,
  EscrowRelayerPreparedTransaction,
  EscrowRelayerTransactionBuilder,
} from './relayer-worker.js';
import type { DecodedEscrowAccount } from './solana-accounts.js';
import type {
  EscrowPositionActivationDatabase,
  EscrowPositionActivationDeployment,
} from './position-activation-service.js';
import { createEscrowJobIdempotencyKey } from './job-state.js';
import { sponsorTransaction } from './transaction-signatures.js';

const payloadSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.literal('activate_position_lot'),
  cluster: z.enum(['localnet', 'devnet', 'mainnet-beta']),
  genesisHash: z.string().min(1),
  programId: z.string().min(1),
  custodyVersion: z.number().int().positive(),
  relayerFeePayer: z.string().min(1),
  marketId: z.string().uuid(),
  marketPda: z.string().min(1),
  documentHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  positionPda: z.string().min(1),
  positionLotPda: z.string().min(1),
  owner: z.string().min(1),
  lotNonce: z.string().regex(/^\d+$/),
  expectedEventEpoch: z.string().regex(/^\d+$/),
  activationTimestamp: z.string().regex(/^\d+$/),
}).strict();

export type EscrowPositionActivationPayload = z.infer<typeof payloadSchema>;

export interface EscrowPositionActivationRelayerChain {
  genesisHash(): Promise<string>;
  unixTimestamp(): Promise<bigint>;
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
  config(address: string): Promise<DecodedEscrowAccount<ProtocolConfigAccount> | null>;
  market(address: string): Promise<DecodedEscrowAccount<MarketAccount> | null>;
  position(address: string): Promise<DecodedEscrowAccount<UserPositionAccount> | null>;
  lot(address: string): Promise<DecodedEscrowAccount<PositionLotAccount> | null>;
}

export type EscrowPositionActivationRelayerErrorCode =
  | 'invalid_payload'
  | 'deployment_mismatch'
  | 'identity_mismatch'
  | 'stale_epoch'
  | 'lot_invalidated'
  | 'state_mismatch'
  | 'activation_not_due'
  | 'transaction_signer_mismatch';

export class EscrowPositionActivationRelayerError extends Error {
  readonly name = 'EscrowPositionActivationRelayerError';

  constructor(readonly code: EscrowPositionActivationRelayerErrorCode) {
    super(`escrow position activation relayer rejected: ${code}`);
  }
}

export function parseEscrowPositionActivationPayload(
  job: DurableEscrowRelayerJobRow,
): EscrowPositionActivationPayload {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success || job.kind !== 'position_activation' || job.custodyMode !== 'escrow') {
    throw new EscrowPositionActivationRelayerError('invalid_payload');
  }
  return parsed.data;
}

function exactAccount<T>(
  account: DecodedEscrowAccount<T> | null,
  address: string,
  programId: string,
): DecodedEscrowAccount<T> {
  if (account === null || account.address !== address || account.ownerProgramId !== programId) {
    throw new EscrowPositionActivationRelayerError('identity_mismatch');
  }
  return account;
}

function validateJobBinding(
  job: DurableEscrowRelayerJobRow,
  payload: EscrowPositionActivationPayload,
  deployment: EscrowPositionActivationDeployment,
): void {
  if (
    job.kind !== 'position_activation' || job.cluster !== deployment.cluster ||
    job.programId !== deployment.programId || job.custodyVersion !== deployment.custodyVersion ||
    job.marketId !== payload.marketId || job.ownerPubkey !== payload.owner ||
    payload.cluster !== deployment.cluster || payload.genesisHash !== deployment.genesisHash ||
    payload.programId !== deployment.programId || payload.custodyVersion !== deployment.custodyVersion ||
    payload.relayerFeePayer !== deployment.relayerFeePayer ||
    job.idempotencyKey !== createEscrowJobIdempotencyKey({
      kind: 'position_activation', programId: deployment.programId,
      marketPda: payload.marketPda, owner: payload.owner,
      lotNonce: BigInt(payload.lotNonce), eventEpoch: BigInt(payload.expectedEventEpoch),
    })
  ) throw new EscrowPositionActivationRelayerError('deployment_mismatch');
  try {
    if (
      deriveMarketPda(deployment.programId, payload.marketId).address !== payload.marketPda ||
      deriveUserPositionPda(deployment.programId, payload.marketPda, payload.owner).address !== payload.positionPda ||
      derivePositionLotPda(
        deployment.programId, payload.marketPda, payload.owner, BigInt(payload.lotNonce),
      ).address !== payload.positionLotPda
    ) throw new EscrowPositionActivationRelayerError('identity_mismatch');
  } catch (error) {
    if (error instanceof EscrowPositionActivationRelayerError) throw error;
    throw new EscrowPositionActivationRelayerError('invalid_payload');
  }
}

function requireLink(
  value: EscrowPlacementMarketLinkResult,
  payload: EscrowPositionActivationPayload,
  deployment: EscrowPositionActivationDeployment,
) {
  if (
    !value.ok || !value.found || value.custodyMode !== 'escrow' ||
    value.custodyVersion !== deployment.custodyVersion || value.cluster !== deployment.cluster ||
    value.genesisHash !== deployment.genesisHash || value.programId !== deployment.programId ||
    value.marketId !== payload.marketId || value.marketPda !== payload.marketPda ||
    value.documentHashHex.toLowerCase() !== payload.documentHashHex.toLowerCase() ||
    value.commitment !== 'finalized' || value.projectionStale
  ) throw new EscrowPositionActivationRelayerError('identity_mismatch');
  return value;
}

interface BuilderOptions {
  readonly db: Pick<EscrowPositionActivationDatabase, 'getMarketLink'>;
  readonly chain: EscrowPositionActivationRelayerChain;
  readonly sponsor: Signer;
  readonly deployment: EscrowPositionActivationDeployment;
}

async function validatedContext(
  options: BuilderOptions,
  job: DurableEscrowRelayerJobRow,
  payload: EscrowPositionActivationPayload,
) {
  validateJobBinding(job, payload, options.deployment);
  const configPda = deriveProtocolConfigPda(options.deployment.programId).address;
  const [observedGenesisHash, linkValue, configValue, marketValue, positionValue, lotValue, unixTimestamp] =
    await Promise.all([
      options.chain.genesisHash(),
      options.db.getMarketLink({
        cluster: options.deployment.cluster, genesisHash: options.deployment.genesisHash,
        programId: options.deployment.programId, marketPda: payload.marketPda,
      }),
      options.chain.config(configPda),
      options.chain.market(payload.marketPda),
      options.chain.position(payload.positionPda),
      options.chain.lot(payload.positionLotPda),
      options.chain.unixTimestamp(),
    ]);
  if (observedGenesisHash !== options.deployment.genesisHash) {
    throw new EscrowPositionActivationRelayerError('deployment_mismatch');
  }
  const link = requireLink(linkValue, payload, options.deployment);
  const config = exactAccount(configValue, configPda, options.deployment.programId);
  let expectedGenesisHashHex: string;
  try {
    expectedGenesisHashHex = bytesToHex(base58Decode(options.deployment.genesisHash));
  } catch {
    throw new EscrowPositionActivationRelayerError('deployment_mismatch');
  }
  if (
    bytesToHex(config.value.clusterGenesisHash) !== expectedGenesisHashHex ||
    config.value.relayerFeePayer !== options.deployment.relayerFeePayer ||
    config.value.relayerFeePayer !== options.sponsor.publicKey.toBase58()
  ) throw new EscrowPositionActivationRelayerError('deployment_mismatch');

  const market = exactAccount(marketValue, payload.marketPda, options.deployment.programId);
  const position = exactAccount(positionValue, payload.positionPda, options.deployment.programId);
  const lot = exactAccount(lotValue, payload.positionLotPda, options.deployment.programId);
  const expectedEpoch = BigInt(payload.expectedEventEpoch);
  const nonce = BigInt(payload.lotNonce);
  const activationTimestamp = BigInt(payload.activationTimestamp);
  if (
    market.value.marketUuid !== payload.marketId ||
    bytesToHex(market.value.marketDocumentHash) !== payload.documentHashHex.toLowerCase() ||
    market.value.oracleSetEpoch !== link.oracleEpoch || market.value.asset !== link.asset ||
    market.value.tokenMint !== link.mintPubkey || market.value.vault !== link.vaultPda ||
    BigInt(market.value.ratioMilli) !== link.ratioMilli || market.value.state !== link.chainState
  ) throw new EscrowPositionActivationRelayerError('identity_mismatch');
  if (market.value.eventEpoch !== expectedEpoch || link.eventEpoch !== expectedEpoch) {
    throw new EscrowPositionActivationRelayerError('stale_epoch');
  }
  if (market.value.state !== 'open' && market.value.state !== 'frozen') {
    throw new EscrowPositionActivationRelayerError('state_mismatch');
  }
  if (
    position.value.market !== payload.marketPda || position.value.owner !== payload.owner ||
    position.value.claimed || position.value.nextLotNonce <= nonce
  ) throw new EscrowPositionActivationRelayerError('identity_mismatch');
  if (
    lot.value.market !== payload.marketPda || lot.value.owner !== payload.owner ||
    lot.value.nonce !== nonce || lot.value.side !== position.value.side || lot.value.amount <= 0n ||
    lot.value.observedEventEpoch !== expectedEpoch || lot.value.activationTimestamp !== activationTimestamp
  ) throw new EscrowPositionActivationRelayerError('identity_mismatch');
  if (lot.value.state === 'voided' || lot.value.invalidationEvidenceHash !== null) {
    throw new EscrowPositionActivationRelayerError('lot_invalidated');
  }
  const pendingTotal = lot.value.side === 'back'
    ? market.value.pendingBackTotal
    : market.value.pendingDoubtTotal;
  if (
    lot.value.state !== 'pending' || position.value.pendingAmount < lot.value.amount ||
    pendingTotal < lot.value.amount
  ) throw new EscrowPositionActivationRelayerError('state_mismatch');
  if (unixTimestamp < activationTimestamp) {
    throw new EscrowPositionActivationRelayerError('activation_not_due');
  }
  return { nonce, expectedEpoch };
}

export function createEscrowPositionActivationTransactionBuilder(
  options: BuilderOptions,
): EscrowRelayerTransactionBuilder {
  if (options.sponsor.publicKey.toBase58() !== options.deployment.relayerFeePayer) {
    throw new EscrowPositionActivationRelayerError('deployment_mismatch');
  }
  return {
    async build(job): Promise<EscrowRelayerPreparedTransaction> {
      const payload = parseEscrowPositionActivationPayload(job);
      const { nonce, expectedEpoch } = await validatedContext(options, job, payload);
      const blockhash = await options.chain.latestBlockhash();
      const instruction = materializeInstruction({
        kind: 'activate_position_lot', marketUuid: payload.marketId,
        owner: payload.owner, lotNonce: nonce, expectedEventEpoch: expectedEpoch,
      }, { programId: new PublicKey(options.deployment.programId) });
      const transaction = buildUnsignedV0Transaction({
        feePayer: options.sponsor.publicKey,
        recentBlockhash: blockhash.blockhash,
        instructions: [instruction],
      });
      if (
        transaction.message.header.numRequiredSignatures !== 1 ||
        !transaction.message.staticAccountKeys[0]?.equals(options.sponsor.publicKey)
      ) throw new EscrowPositionActivationRelayerError('transaction_signer_mismatch');
      const signed = sponsorTransaction(transaction, options.sponsor);
      return {
        rawTransactionBase64: signed.rawTransactionBase64,
        expectedSignature: signed.expectedSignature,
        transactionMessageHashHex: signed.messageHashHex,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      };
    },
  };
}

export function createEscrowPositionActivationFinalityVerifier(options: {
  readonly chain: Pick<EscrowPositionActivationRelayerChain, 'genesisHash' | 'market' | 'position' | 'lot'>;
  readonly deployment: EscrowPositionActivationDeployment;
}): EscrowRelayerFinalityVerifier {
  return {
    async confirm(job) {
      let payload: EscrowPositionActivationPayload;
      try {
        payload = parseEscrowPositionActivationPayload(job);
        validateJobBinding(job, payload, options.deployment);
      } catch {
        return 'mismatch';
      }
      const [genesisHash, market, position, lot] = await Promise.all([
        options.chain.genesisHash(), options.chain.market(payload.marketPda),
        options.chain.position(payload.positionPda), options.chain.lot(payload.positionLotPda),
      ]);
      if (
        genesisHash !== options.deployment.genesisHash || market === null || position === null || lot === null ||
        market.ownerProgramId !== options.deployment.programId || position.ownerProgramId !== options.deployment.programId ||
        lot.ownerProgramId !== options.deployment.programId || market.address !== payload.marketPda ||
        position.address !== payload.positionPda || lot.address !== payload.positionLotPda ||
        market.value.marketUuid !== payload.marketId || position.value.market !== payload.marketPda ||
        position.value.owner !== payload.owner || lot.value.market !== payload.marketPda ||
        lot.value.owner !== payload.owner || lot.value.nonce !== BigInt(payload.lotNonce) ||
        lot.value.observedEventEpoch !== BigInt(payload.expectedEventEpoch)
      ) return 'mismatch';
      if (lot.value.state === 'active') return 'confirmed';
      if (
        lot.value.state === 'voided' && lot.value.invalidationEvidenceHash !== null &&
        market.value.eventEpoch > BigInt(payload.expectedEventEpoch)
      ) return 'confirmed';
      if (
        lot.value.invalidationEvidenceHash !== null ||
        market.value.eventEpoch > BigInt(payload.expectedEventEpoch)
      ) return 'mismatch';
      return 'pending';
    },
  };
}
