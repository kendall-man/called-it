import {
  buildAttestationVerificationInstructions,
  buildUnsignedV0Transaction,
  bytesToHex,
  deriveOracleSetPda,
  derivePositionLotPda,
  encodeFeedEventAttestationV1,
  encodePositionInvalidationAttestationV1,
  materializeInstruction,
  type MarketAccount,
  type OracleSetAccount,
  type PositionLotAccount,
} from '@calledit/escrow-sdk';
import { PublicKey, type Signer, type TransactionInstruction } from '@solana/web3.js';
import type { DecodedEscrowAccount } from './solana-accounts.js';
import {
  parseControlPayload,
  restoreControlSignatures,
  restoreFeedAttestation,
  restoreInvalidationAttestation,
  type EscrowControlPayload,
} from './control-payload.js';
import type { EscrowControlDatabase, EscrowControlDeployment } from './control-workflows.js';
import type {
  DurableEscrowRelayerJobRow,
  EscrowRelayerFinalityVerifier,
  EscrowRelayerPreparedTransaction,
  EscrowRelayerTransactionBuilder,
} from './relayer-worker.js';
import { sponsorTransaction, sponsorTransactionWithAuthority } from './transaction-signatures.js';

export interface EscrowControlChain {
  genesisHash(): Promise<string>;
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
  market(address: string): Promise<DecodedEscrowAccount<MarketAccount> | null>;
  lot(address: string): Promise<DecodedEscrowAccount<PositionLotAccount> | null>;
  oracleSet(address: string): Promise<DecodedEscrowAccount<OracleSetAccount> | null>;
}

export class EscrowControlRelayerError extends Error {
  readonly name = 'EscrowControlRelayerError';
  constructor(readonly code: 'identity_mismatch' | 'state_mismatch' | 'oracle_threshold_unavailable' | 'transaction_too_large') {
    super(`escrow control relayer rejected: ${code}`);
  }
}

interface Options {
  readonly db: Pick<EscrowControlDatabase, 'getMarketLink'>;
  readonly chain: EscrowControlChain;
  readonly sponsor: Signer;
  readonly feedOperator: Signer;
  readonly deployment: EscrowControlDeployment;
}

async function context(options: Options, payload: EscrowControlPayload) {
  const [link, genesis, market] = await Promise.all([
    options.db.getMarketLink({
      cluster: options.deployment.cluster, genesisHash: options.deployment.genesisHash,
      programId: options.deployment.programId, marketPda: payload.marketPda,
    }),
    options.chain.genesisHash(),
    options.chain.market(payload.marketPda),
  ]);
  if (
    !link.ok || !link.found || link.custodyMode !== 'escrow' ||
    link.cluster !== options.deployment.cluster || link.genesisHash !== options.deployment.genesisHash ||
    link.programId !== options.deployment.programId || link.marketPda !== payload.marketPda ||
    link.marketId !== payload.marketId || link.documentHashHex !== payload.documentHashHex.toLowerCase() ||
    link.oracleEpoch !== BigInt(payload.oracleEpoch) || link.commitment !== 'finalized' || link.projectionStale ||
    genesis !== options.deployment.genesisHash || market === null ||
    market.ownerProgramId !== options.deployment.programId || market.value.marketUuid !== payload.marketId ||
    bytesToHex(market.value.marketDocumentHash) !== payload.documentHashHex.toLowerCase() ||
    market.value.oracleSetEpoch !== link.oracleEpoch
  ) throw new EscrowControlRelayerError('identity_mismatch');
  return { link, market };
}

async function thresholdInstructions(
  options: Options,
  payload: EscrowControlPayload,
  market: DecodedEscrowAccount<MarketAccount>,
): Promise<readonly TransactionInstruction[]> {
  const signatures = restoreControlSignatures(payload.signatures);
  const oracle = await options.chain.oracleSet(
    deriveOracleSetPda(options.deployment.programId, market.value.oracleSetEpoch).address,
  );
  const signerAddresses = new Set(signatures.map((value) => new PublicKey(value.publicKey).toBase58()));
  if (
    oracle === null || oracle.ownerProgramId !== options.deployment.programId ||
    oracle.value.epoch !== market.value.oracleSetEpoch ||
    signatures.length < oracle.value.signatureThreshold || signerAddresses.size !== signatures.length ||
    [...signerAddresses].some((address) => !oracle.value.signers.includes(address))
  ) throw new EscrowControlRelayerError('oracle_threshold_unavailable');
  if (payload.operation === 'invalidate_position_lot') {
    const attestation = restoreInvalidationAttestation(payload.attestation);
    return buildAttestationVerificationInstructions(
      encodePositionInvalidationAttestationV1(attestation), signatures,
    );
  }
  const attestation = restoreFeedAttestation(payload.attestation);
  return buildAttestationVerificationInstructions(encodeFeedEventAttestationV1(attestation), signatures);
}

async function instructions(
  options: Options,
  payload: EscrowControlPayload,
  market: DecodedEscrowAccount<MarketAccount>,
): Promise<readonly TransactionInstruction[]> {
  const verification = await thresholdInstructions(options, payload, market);
  const programId = new PublicKey(options.deployment.programId);
  if (payload.operation === 'freeze_market') {
    const attestation = restoreFeedAttestation(payload.attestation);
    const expected = payload.expectedEventEpoch === undefined ? -1n : BigInt(payload.expectedEventEpoch);
    if (
      market.value.state !== 'open' || market.value.eventEpoch !== expected ||
      attestation.eventKind !== 'freeze' || attestation.eventEpoch !== expected + 1n ||
      payload.feedOperatorAuthority !== options.feedOperator.publicKey.toBase58()
    ) throw new EscrowControlRelayerError('state_mismatch');
    return [...verification, materializeInstruction({
      kind: 'freeze_market', feedOperatorAuthority: options.feedOperator.publicKey,
      marketUuid: payload.marketId, expectedEventEpoch: expected,
      evidenceHash: attestation.evidenceHash,
    }, { programId })];
  }
  if (payload.operation === 'unfreeze_market') {
    const attestation = restoreFeedAttestation(payload.attestation);
    if (
      market.value.state !== 'frozen' || attestation.eventKind !== 'unfreeze' ||
      attestation.eventEpoch !== market.value.eventEpoch + 1n
    ) throw new EscrowControlRelayerError('state_mismatch');
    return [...verification, materializeInstruction({
      kind: 'unfreeze_market', marketUuid: payload.marketId, attestation,
    }, { programId })];
  }
  const attestation = restoreInvalidationAttestation(payload.attestation);
  if (payload.owner === undefined || payload.lotNonce === undefined || payload.positionLotPda === undefined) {
    throw new EscrowControlRelayerError('identity_mismatch');
  }
  const nonce = BigInt(payload.lotNonce);
  const expectedLot = derivePositionLotPda(
    options.deployment.programId, payload.marketPda, payload.owner, nonce,
  ).address;
  const lot = await options.chain.lot(expectedLot);
  if (
    payload.positionLotPda !== expectedLot || lot === null || lot.ownerProgramId !== options.deployment.programId ||
    lot.value.market !== payload.marketPda || lot.value.owner !== payload.owner || lot.value.nonce !== nonce ||
    (lot.value.state !== 'pending' && lot.value.state !== 'active') ||
    lot.value.activationTimestamp === null || attestation.lotNonce !== nonce ||
    bytesToHex(attestation.positionLotPda) !== bytesToHex(new PublicKey(expectedLot).toBytes()) ||
    attestation.observedEventEpoch !== lot.value.observedEventEpoch ||
    attestation.invalidatedEventEpoch > market.value.eventEpoch
  ) throw new EscrowControlRelayerError('state_mismatch');
  return [...verification, materializeInstruction({
    kind: 'invalidate_position_lot', marketUuid: payload.marketId,
    owner: payload.owner, lotNonce: nonce, attestation,
  }, { programId })];
}

export function createEscrowControlTransactionBuilder(options: Options): EscrowRelayerTransactionBuilder {
  if (
    options.sponsor.publicKey.toBase58() === options.feedOperator.publicKey.toBase58() ||
    options.feedOperator.publicKey.toBase58() !== options.deployment.feedOperatorAuthority
  ) throw new EscrowControlRelayerError('identity_mismatch');
  return {
    async build(job: DurableEscrowRelayerJobRow): Promise<EscrowRelayerPreparedTransaction> {
      const payload = parseControlPayload(job);
      if (job.programId !== options.deployment.programId) throw new EscrowControlRelayerError('identity_mismatch');
      const { market } = await context(options, payload);
      const [builtInstructions, blockhash] = await Promise.all([
        instructions(options, payload, market), options.chain.latestBlockhash(),
      ]);
      const transaction = buildUnsignedV0Transaction({
        feePayer: options.sponsor.publicKey,
        recentBlockhash: blockhash.blockhash,
        instructions: builtInstructions,
      });
      try {
        const signed = payload.operation === 'freeze_market'
          ? sponsorTransactionWithAuthority(transaction, options.sponsor, options.feedOperator)
          : sponsorTransaction(transaction, options.sponsor);
        return {
          rawTransactionBase64: signed.rawTransactionBase64,
          expectedSignature: signed.expectedSignature,
          transactionMessageHashHex: signed.messageHashHex,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
        };
      } catch (error) {
        if (error instanceof RangeError && error.message.includes('encoding overruns Uint8Array')) {
          throw new EscrowControlRelayerError('transaction_too_large');
        }
        throw error;
      }
    },
  };
}

export function createEscrowControlFinalityVerifier(options: {
  readonly chain: Pick<EscrowControlChain, 'market' | 'lot'>;
  readonly programId: string;
}): EscrowRelayerFinalityVerifier {
  return {
    async confirm(job) {
      const payload = parseControlPayload(job);
      const market = await options.chain.market(payload.marketPda);
      if (market === null || market.ownerProgramId !== options.programId) return 'pending';
      if (payload.operation === 'freeze_market' || payload.operation === 'unfreeze_market') {
        const attestation = restoreFeedAttestation(payload.attestation);
        const expectedState = payload.operation === 'freeze_market' ? 'frozen' : 'open';
        if (market.value.eventEpoch === attestation.eventEpoch && market.value.state === expectedState) return 'confirmed';
        return market.value.eventEpoch > attestation.eventEpoch ? 'mismatch' : 'pending';
      }
      if (payload.positionLotPda === undefined) return 'mismatch';
      const lot = await options.chain.lot(payload.positionLotPda);
      if (lot === null) return 'pending';
      const attestation = restoreInvalidationAttestation(payload.attestation);
      if (
        lot.value.state === 'voided' && lot.value.invalidationEvidenceHash !== null &&
        bytesToHex(lot.value.invalidationEvidenceHash) === bytesToHex(attestation.evidenceHash)
      ) return 'confirmed';
      return lot.value.state === 'active' ? 'mismatch' : 'pending';
    },
  };
}
