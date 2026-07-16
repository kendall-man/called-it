import { createHash } from 'node:crypto';
import {
  buildSettlementAttestationVerificationInstructions,
  buildUnsignedV0Transaction,
  buildVoidAttestationVerificationInstructions,
  bytesToHex,
  deriveMarketPda,
  deriveOracleSetPda,
  deriveUserPositionPda,
  materializeInstruction,
  type MarketAccount,
  type OracleSetAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import { PublicKey, type Signer, type TransactionInstruction } from '@solana/web3.js';
import type { DecodedEscrowAccount } from './solana-accounts.js';
import type { EscrowPlacementMarketLinkResult } from './placement-types.js';
import {
  parseRecoveryPayload,
  restoreSettlement,
  restoreSignatures,
  restoreVoid,
  type EscrowRecoveryPayload,
} from './recovery-payload.js';
import type { EscrowRecoveryDatabase, EscrowRecoveryDeployment } from './recovery-workflows.js';
import type {
  DurableEscrowRelayerJobRow,
  EscrowRelayerPreparedTransaction,
  EscrowRelayerTransactionBuilder,
} from './relayer-worker.js';
import { sponsorTransaction } from './transaction-signatures.js';

export interface EscrowRecoveryChain {
  genesisHash(): Promise<string>;
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
  market(address: string): Promise<DecodedEscrowAccount<MarketAccount> | null>;
  position(address: string): Promise<DecodedEscrowAccount<UserPositionAccount> | null>;
  oracleSet(address: string): Promise<DecodedEscrowAccount<OracleSetAccount> | null>;
  accountExists(address: string): Promise<boolean>;
}

export class EscrowRecoveryRelayerError extends Error {
  readonly name = 'EscrowRecoveryRelayerError';
  constructor(readonly code: 'invalid_payload' | 'identity_mismatch' | 'account_unavailable' | 'state_mismatch' | 'oracle_threshold_unavailable' | 'transaction_too_large') {
    super(`escrow recovery relayer rejected: ${code}`);
  }
}

function requireLink(
  value: EscrowPlacementMarketLinkResult,
  payload: EscrowRecoveryPayload,
  deployment: EscrowRecoveryDeployment,
) {
  if (
    !value.ok || !value.found || value.cluster !== deployment.cluster ||
    value.genesisHash !== deployment.genesisHash || value.programId !== deployment.programId ||
    value.custodyVersion !== deployment.custodyVersion || value.marketId !== payload.marketId ||
    value.marketPda !== payload.marketPda || value.documentHashHex !== payload.documentHashHex.toLowerCase() ||
    value.oracleEpoch !== BigInt(payload.oracleEpoch) || value.asset !== payload.asset ||
    value.mintPubkey !== payload.mintPubkey || value.commitment !== 'finalized' || value.projectionStale
  ) throw new EscrowRecoveryRelayerError('identity_mismatch');
  return value;
}

async function loadMarket(options: RecoveryBuilderOptions, payload: EscrowRecoveryPayload) {
  const link = requireLink(await options.db.getMarketLink({
    cluster: options.deployment.cluster, genesisHash: options.deployment.genesisHash,
    programId: options.deployment.programId, marketPda: payload.marketPda,
  }), payload, options.deployment);
  const [genesisHash, market] = await Promise.all([
    options.chain.genesisHash(), options.chain.market(payload.marketPda),
  ]);
  if (genesisHash !== options.deployment.genesisHash || market === null) {
    throw new EscrowRecoveryRelayerError('account_unavailable');
  }
  if (
    market.ownerProgramId !== options.deployment.programId || market.address !== payload.marketPda ||
    market.value.marketUuid !== payload.marketId ||
    deriveMarketPda(options.deployment.programId, market.value.marketUuid).address !== payload.marketPda ||
    bytesToHex(market.value.marketDocumentHash) !== payload.documentHashHex.toLowerCase() ||
    market.value.oracleSetEpoch !== link.oracleEpoch || market.value.asset !== link.asset ||
    market.value.tokenMint !== link.mintPubkey || market.value.vault !== link.vaultPda ||
    BigInt(market.value.ratioMilli) !== link.ratioMilli || market.value.eventEpoch < link.eventEpoch
  ) throw new EscrowRecoveryRelayerError('identity_mismatch');
  return { link, market };
}

async function loadPosition(
  options: RecoveryBuilderOptions,
  payload: EscrowRecoveryPayload,
  market: DecodedEscrowAccount<MarketAccount>,
) {
  if (payload.owner === undefined) throw new EscrowRecoveryRelayerError('invalid_payload');
  const address = deriveUserPositionPda(options.deployment.programId, payload.marketPda, payload.owner).address;
  const position = await options.chain.position(address);
  if (
    position === null || position.ownerProgramId !== options.deployment.programId ||
    position.value.market !== market.address || position.value.owner !== payload.owner
  ) throw new EscrowRecoveryRelayerError('account_unavailable');
  return position;
}

async function attestedInstructions(
  options: RecoveryBuilderOptions,
  payload: EscrowRecoveryPayload,
  market: DecodedEscrowAccount<MarketAccount>,
): Promise<readonly TransactionInstruction[]> {
  const signatures = restoreSignatures(payload.signatures);
  const oracleAddress = deriveOracleSetPda(options.deployment.programId, market.value.oracleSetEpoch).address;
  const oracle = await options.chain.oracleSet(oracleAddress);
  if (oracle === null || oracle.ownerProgramId !== options.deployment.programId || oracle.value.epoch !== market.value.oracleSetEpoch) {
    throw new EscrowRecoveryRelayerError('identity_mismatch');
  }
  const signerAddresses = new Set(signatures.map((value) => new PublicKey(value.publicKey).toBase58()));
  if (
    signerAddresses.size !== signatures.length || signatures.length < oracle.value.signatureThreshold ||
    [...signerAddresses].some((address) => !oracle.value.signers.includes(address))
  ) throw new EscrowRecoveryRelayerError('oracle_threshold_unavailable');
  const programId = new PublicKey(options.deployment.programId);
  if (payload.operation === 'settle_market') {
    const attestation = restoreSettlement(payload.attestation);
    if (attestation.fixtureId !== market.value.fixtureId || attestation.oracleSetEpoch !== market.value.oracleSetEpoch) {
      throw new EscrowRecoveryRelayerError('identity_mismatch');
    }
    return [
      ...buildSettlementAttestationVerificationInstructions(attestation, signatures),
      materializeInstruction({ kind: 'settle_market', marketUuid: payload.marketId, attestation }, { programId }),
    ];
  }
  if (payload.operation !== 'void_market') throw new EscrowRecoveryRelayerError('invalid_payload');
  const attestation = restoreVoid(payload.attestation);
  if (attestation.fixtureId !== market.value.fixtureId || attestation.oracleSetEpoch !== market.value.oracleSetEpoch) {
    throw new EscrowRecoveryRelayerError('identity_mismatch');
  }
  return [
    ...buildVoidAttestationVerificationInstructions(attestation, signatures),
    materializeInstruction({ kind: 'void_market', marketUuid: payload.marketId, attestation }, { programId }),
  ];
}

async function recoveryInstructions(
  options: RecoveryBuilderOptions,
  payload: EscrowRecoveryPayload,
  market: DecodedEscrowAccount<MarketAccount>,
): Promise<readonly TransactionInstruction[]> {
  if (payload.operation === 'settle_market' || payload.operation === 'void_market') {
    if (market.value.state !== 'open' && market.value.state !== 'frozen') {
      throw new EscrowRecoveryRelayerError('state_mismatch');
    }
    return attestedInstructions(options, payload, market);
  }
  const programId = new PublicKey(options.deployment.programId);
  if (payload.operation === 'timeout_void') {
    return [materializeInstruction({ kind: 'timeout_void', marketUuid: payload.marketId }, { programId })];
  }
  if (payload.operation === 'close_market') {
    if (
      (market.value.state !== 'settled' && market.value.state !== 'voided') ||
      market.value.claimedPositionCount !== market.value.positionCount ||
      market.value.settlementProcessedPositionCount !== 0n ||
      market.value.residualRecipient !== options.deployment.residualRecipient
    ) throw new EscrowRecoveryRelayerError('state_mismatch');
    return [materializeInstruction({
      kind: 'close_market', marketUuid: payload.marketId, asset: payload.asset,
      canonicalUsdcMint: options.deployment.canonicalUsdcMint,
      residualRecipient: options.deployment.residualRecipient,
    }, { programId })];
  }
  const position = await loadPosition(options, payload, market);
  const owner = position.value.owner;
  switch (payload.operation) {
    case 'calculate_position_entitlement':
      if (market.value.state !== 'settling' || position.value.settlementProcessed) throw new EscrowRecoveryRelayerError('state_mismatch');
      return [materializeInstruction({ kind: payload.operation, marketUuid: payload.marketId, owner }, { programId })];
    case 'claim_position_for':
      if (position.value.claimed || (market.value.state !== 'settled' && market.value.state !== 'voided')) {
        throw new EscrowRecoveryRelayerError('state_mismatch');
      }
      return [materializeInstruction({
        kind: payload.operation, payer: options.sponsor.publicKey, marketUuid: payload.marketId,
        owner, asset: payload.asset, canonicalUsdcMint: options.deployment.canonicalUsdcMint,
      }, { programId })];
    case 'close_position_lots': {
      const lotNonces = payload.lotNonces?.map(BigInt);
      if (!position.value.claimed || lotNonces === undefined || lotNonces.length === 0) throw new EscrowRecoveryRelayerError('state_mismatch');
      return [materializeInstruction({
        kind: payload.operation, marketUuid: payload.marketId, owner,
        rentRecipient: options.deployment.relayerFeePayer, lotNonces,
      }, { programId })];
    }
    case 'close_position':
      if (!position.value.claimed || position.value.nextLotNonce !== 0n) throw new EscrowRecoveryRelayerError('state_mismatch');
      return [materializeInstruction({
        kind: payload.operation, marketUuid: payload.marketId, owner,
        rentRecipient: options.deployment.relayerFeePayer,
      }, { programId })];
  }
}

interface RecoveryBuilderOptions {
  readonly db: Pick<EscrowRecoveryDatabase, 'getMarketLink'>;
  readonly chain: EscrowRecoveryChain;
  readonly sponsor: Signer;
  readonly deployment: EscrowRecoveryDeployment;
}

export interface EscrowRecoveryTransactionBuilder extends EscrowRelayerTransactionBuilder {
  buildDirectClaim(input: { readonly marketPda: string; readonly owner: string }): Promise<{
    readonly rawTransactionBase64: string;
    readonly transactionMessageHashHex: string;
    readonly lastValidBlockHeight: bigint;
  }>;
}

export function createEscrowRecoveryTransactionBuilder(options: RecoveryBuilderOptions): EscrowRecoveryTransactionBuilder {
  if (options.sponsor.publicKey.toBase58() !== options.deployment.relayerFeePayer) {
    throw new EscrowRecoveryRelayerError('identity_mismatch');
  }
  return {
    async build(job: DurableEscrowRelayerJobRow): Promise<EscrowRelayerPreparedTransaction> {
      const payload = parseRecoveryPayload(job);
      if (job.programId !== options.deployment.programId) throw new EscrowRecoveryRelayerError('identity_mismatch');
      const { market } = await loadMarket(options, payload);
      const [instructions, blockhash] = await Promise.all([
        recoveryInstructions(options, payload, market), options.chain.latestBlockhash(),
      ]);
      const transaction = buildUnsignedV0Transaction({
        feePayer: options.sponsor.publicKey, recentBlockhash: blockhash.blockhash, instructions,
      });
      let signed: ReturnType<typeof sponsorTransaction>;
      try {
        signed = sponsorTransaction(transaction, options.sponsor);
      } catch (error) {
        if (error instanceof RangeError && error.message.includes('encoding overruns Uint8Array')) {
          throw new EscrowRecoveryRelayerError('transaction_too_large');
        }
        throw error;
      }
      return { ...signed, transactionMessageHashHex: signed.messageHashHex, lastValidBlockHeight: blockhash.lastValidBlockHeight };
    },
    async buildDirectClaim(input) {
      const link = await options.db.getMarketLink({
        cluster: options.deployment.cluster, genesisHash: options.deployment.genesisHash,
        programId: options.deployment.programId, marketPda: input.marketPda,
      });
      if (!link.ok || !link.found) throw new EscrowRecoveryRelayerError('identity_mismatch');
      const payload: EscrowRecoveryPayload = {
        schemaVersion: 1, operation: 'claim_position_for', marketId: link.marketId,
        marketPda: link.marketPda, documentHashHex: link.documentHashHex,
        oracleEpoch: String(link.oracleEpoch), asset: link.asset, mintPubkey: link.mintPubkey,
        owner: input.owner,
      };
      const { market } = await loadMarket(options, payload);
      const position = await loadPosition(options, payload, market);
      if (position.value.claimed || (market.value.state !== 'settled' && market.value.state !== 'voided')) {
        throw new EscrowRecoveryRelayerError('state_mismatch');
      }
      const blockhash = await options.chain.latestBlockhash();
      const transaction = buildUnsignedV0Transaction({
        feePayer: input.owner, recentBlockhash: blockhash.blockhash,
        instructions: [materializeInstruction({
          kind: 'claim_position', marketUuid: link.marketId, owner: input.owner,
          asset: link.asset, canonicalUsdcMint: options.deployment.canonicalUsdcMint,
        }, { programId: new PublicKey(options.deployment.programId) })],
      });
      const message = transaction.message.serialize();
      return {
        rawTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
        transactionMessageHashHex: createHash('sha256').update(message).digest('hex'),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      };
    },
  };
}
