import { createHash } from 'node:crypto';
import {
  buildAttestationVerificationInstructions,
  encodePositionInvalidationAttestationV1,
  encodeSettlementAttestationV1,
  encodeVoidAttestationV1,
  type AttestationCommonV1,
  type PositionInvalidationAttestationV1,
  type SettlementAttestationV1,
  type VoidAttestationV1,
} from '@calledit/escrow-sdk';
import { Ed25519Program, type Keypair, type TransactionInstruction } from '@solana/web3.js';
import { chainTimestamp, connection } from './runtime.js';
import type { BootstrapContext, OpenedMarket, PlacedPosition } from './types.js';

export function evidenceHash(label: string): Uint8Array {
  return createHash('sha256').update(`calledit-local-evidence:${label}`).digest();
}

async function common(context: BootstrapContext, market: OpenedMarket, label: string): Promise<AttestationCommonV1> {
  const now = await chainTimestamp(connection(context.rpcUrl));
  return {
    clusterGenesisHash: context.genesisBytes,
    escrowProgramId: context.programId.toBytes(),
    marketPda: market.market.toBytes(),
    marketDocumentHash: market.documentHash,
    fixtureId: market.document.fixtureId,
    oracleSetEpoch: context.oracleEpoch,
    issuedAt: now - 1n,
    expiresAt: now + 120n,
    evidenceHash: evidenceHash(label),
  };
}

export function thresholdInstructions(context: BootstrapContext, message: Uint8Array): readonly TransactionInstruction[] {
  return thresholdInstructionsForSigners(context.roles.oracles.slice(0, 2), message);
}

export function thresholdInstructionsForSigners(
  signers: readonly Keypair[],
  message: Uint8Array,
): readonly TransactionInstruction[] {
  if (signers.length !== 2) throw new RangeError('threshold fixture requires exactly two oracle signers');
  const signatures = signers.map((signer) => {
    const single = Ed25519Program.createInstructionWithPrivateKey({ privateKey: signer.secretKey, message });
    const data = Buffer.from(single.data);
    const publicKeyOffset = data.readUInt16LE(6);
    const signatureOffset = data.readUInt16LE(2);
    return {
      publicKey: data.subarray(publicKeyOffset, publicKeyOffset + 32),
      signature: data.subarray(signatureOffset, signatureOffset + 64),
    };
  });
  return buildAttestationVerificationInstructions(message, signatures);
}

export async function settlementAttestation(
  context: BootstrapContext,
  market: OpenedMarket,
): Promise<{ readonly value: SettlementAttestationV1; readonly message: Uint8Array }> {
  const value: SettlementAttestationV1 = {
    ...await common(context, market, `${market.document.marketUuid}:settlement`),
    outcome: 'claim_won',
    decidingSequence: 900n,
    terminalPhase: 'F',
    regulationScore: { home: 2, away: 1 },
    fullMatchScore: { home: 2, away: 1 },
    evidenceSequenceCommitment: evidenceHash(`${market.document.marketUuid}:sequence`),
    normalizedEvidenceRoot: evidenceHash(`${market.document.marketUuid}:root`),
  };
  return { value, message: encodeSettlementAttestationV1(value) };
}

export async function voidAttestation(
  context: BootstrapContext,
  market: OpenedMarket,
): Promise<{ readonly value: VoidAttestationV1; readonly message: Uint8Array }> {
  const value: VoidAttestationV1 = {
    ...await common(context, market, `${market.document.marketUuid}:void`),
    reason: 'cancelled',
    decidingSequence: 901n,
  };
  return { value, message: encodeVoidAttestationV1(value) };
}

export async function invalidationAttestation(
  context: BootstrapContext,
  placement: PlacedPosition,
): Promise<{ readonly value: PositionInvalidationAttestationV1; readonly message: Uint8Array }> {
  const value: PositionInvalidationAttestationV1 = {
    ...await common(context, placement.market, `${placement.market.document.marketUuid}:invalidation`),
    positionLotPda: placement.lot.toBytes(),
    lotNonce: placement.nonce,
    observedEventEpoch: 0n,
    invalidatedEventEpoch: 1n,
    decidingSequence: 902n,
  };
  return { value, message: encodePositionInvalidationAttestationV1(value) };
}
