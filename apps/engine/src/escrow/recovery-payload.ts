import {
  hexToBytes,
  type AttestationSignature,
  type SettlementAttestationV1,
  type VoidAttestationV1,
} from '@calledit/escrow-sdk';
import { z } from 'zod';
import type { DurableEscrowRelayerJobRow } from './relayer-worker.js';

const common = z.object({
  clusterGenesisHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  escrowProgramId: z.string().regex(/^[0-9a-fA-F]{64}$/),
  marketPda: z.string().regex(/^[0-9a-fA-F]{64}$/),
  marketDocumentHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  fixtureId: z.string().regex(/^\d+$/), oracleSetEpoch: z.string().regex(/^\d+$/),
  issuedAt: z.string().regex(/^-?\d+$/), expiresAt: z.string().regex(/^-?\d+$/),
  evidenceHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

const score = z.object({ home: z.number().int().nonnegative(), away: z.number().int().nonnegative() });
const settlement = common.extend({
  outcome: z.enum(['claim_won', 'claim_lost']), decidingSequence: z.string().regex(/^\d+$/),
  terminalPhase: z.enum(['F', 'FET', 'FPE']), regulationScore: score.nullable(), fullMatchScore: score.nullable(),
  evidenceSequenceCommitment: z.string().regex(/^[0-9a-fA-F]{64}$/),
  normalizedEvidenceRoot: z.string().regex(/^[0-9a-fA-F]{64}$/),
});
const voidAttestation = common.extend({
  reason: z.enum(['cancelled', 'abandoned', 'coverage_loss', 'undecidable']),
  decidingSequence: z.string().regex(/^\d+$/),
});

const payloadSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.enum([
    'settle_market', 'void_market', 'timeout_void', 'calculate_position_entitlement',
    'claim_position_for', 'close_position_lots', 'close_position', 'close_market',
  ]),
  marketId: z.string().uuid(), marketPda: z.string().min(1),
  documentHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/), oracleEpoch: z.string().regex(/^\d+$/),
  asset: z.enum(['sol', 'usdc']), mintPubkey: z.string().min(1).nullable(),
  owner: z.string().min(1).optional(), lotNonces: z.array(z.string().regex(/^\d+$/)).optional(),
  attestation: z.union([settlement, voidAttestation]).optional(),
  signatures: z.array(z.object({
    publicKeyHex: z.string().regex(/^[0-9a-fA-F]{64}$/), signatureBase64: z.string().min(1),
  })).optional(),
}).passthrough();

export type EscrowRecoveryPayload = z.infer<typeof payloadSchema>;

export function parseRecoveryPayload(job: DurableEscrowRelayerJobRow): EscrowRecoveryPayload {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success || job.marketId !== parsed.data.marketId || job.custodyMode !== 'escrow') {
    throw new TypeError('invalid escrow recovery payload');
  }
  return parsed.data;
}

function restoreCommon(value: z.infer<typeof common>) {
  return {
    clusterGenesisHash: hexToBytes(value.clusterGenesisHash),
    escrowProgramId: hexToBytes(value.escrowProgramId),
    marketPda: hexToBytes(value.marketPda), marketDocumentHash: hexToBytes(value.marketDocumentHash),
    fixtureId: BigInt(value.fixtureId), oracleSetEpoch: BigInt(value.oracleSetEpoch),
    issuedAt: BigInt(value.issuedAt), expiresAt: BigInt(value.expiresAt),
    evidenceHash: hexToBytes(value.evidenceHash),
  };
}

export function restoreSettlement(value: unknown): SettlementAttestationV1 {
  const parsed = settlement.parse(value);
  return {
    ...restoreCommon(parsed), outcome: parsed.outcome, decidingSequence: BigInt(parsed.decidingSequence),
    terminalPhase: parsed.terminalPhase, regulationScore: parsed.regulationScore,
    fullMatchScore: parsed.fullMatchScore,
    evidenceSequenceCommitment: hexToBytes(parsed.evidenceSequenceCommitment),
    normalizedEvidenceRoot: hexToBytes(parsed.normalizedEvidenceRoot),
  };
}

export function restoreVoid(value: unknown): VoidAttestationV1 {
  const parsed = voidAttestation.parse(value);
  return { ...restoreCommon(parsed), reason: parsed.reason, decidingSequence: BigInt(parsed.decidingSequence) };
}

export function restoreSignatures(value: EscrowRecoveryPayload['signatures']): readonly AttestationSignature[] {
  if (value === undefined || value.length === 0) throw new TypeError('missing escrow recovery signatures');
  return value.map((signature) => ({
    publicKey: hexToBytes(signature.publicKeyHex),
    signature: Uint8Array.from(Buffer.from(signature.signatureBase64, 'base64')),
  }));
}
