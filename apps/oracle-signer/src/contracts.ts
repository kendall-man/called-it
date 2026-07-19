import { createHash } from 'node:crypto';
import {
  bytesToHex,
  encodeFeedEventAttestationV1,
  encodePositionInvalidationAttestationV1,
  encodeSettlementAttestationV1,
  encodeVoidAttestationV1,
  hexToBytes,
  type FeedEventAttestationV1,
  type PositionInvalidationAttestationV1,
  type SettlementAttestationV1,
  type VoidAttestationV1,
} from '@calledit/escrow-sdk';
import { z } from 'zod';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const decimal = z.string().regex(/^\d+$/);
const signedDecimal = z.string().regex(/^-?\d+$/);
const score = z.object({ home: z.number().int().min(0).max(65_535), away: z.number().int().min(0).max(65_535) }).strict();
const common = {
  clusterGenesisHash: hash,
  escrowProgramId: hash,
  marketPda: hash,
  marketDocumentHash: hash,
  fixtureId: decimal,
  oracleSetEpoch: decimal,
  issuedAt: signedDecimal,
  expiresAt: signedDecimal,
  evidenceHash: hash,
} as const;
const feed = z.object({
  ...common,
  eventKind: z.enum(['freeze', 'unfreeze', 'price_moving']),
  eventEpoch: decimal,
  decidingSequence: decimal,
  observedAt: signedDecimal,
}).strict();
const invalidation = z.object({
  ...common,
  positionLotPda: hash,
  lotNonce: decimal,
  observedEventEpoch: decimal,
  invalidatedEventEpoch: decimal,
  decidingSequence: decimal,
}).strict();
const settlement = z.object({
  ...common,
  outcome: z.enum(['claim_won', 'claim_lost']),
  decidingSequence: decimal,
  terminalPhase: z.string().min(1).max(32),
  regulationScore: score.nullable(),
  fullMatchScore: score.nullable(),
  evidenceSequenceCommitment: hash,
  normalizedEvidenceRoot: hash,
}).strict();
const voidValue = z.object({
  ...common,
  reason: z.enum(['cancelled', 'abandoned', 'coverage_loss', 'undecidable']),
  decidingSequence: decimal,
}).strict();

const base64 = z.string().refine((value) => {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.toString('base64') === value;
});

const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(['feed_event', 'position_invalidation', 'settlement', 'void']),
  canonicalBytesBase64: base64,
  canonicalSha256Hex: hash,
  clusterGenesisHashHex: hash,
  programIdHex: hash,
  marketPdaHex: hash,
  marketDocumentHashHex: hash,
  oracleSetEpoch: decimal,
  evidenceHashHex: hash,
  claimSpecificationJson: z.string().min(2).max(16_384),
  evidenceCodecVersion: z.literal(2),
  attestationJson: z.record(z.string(), z.unknown()),
}).strict();

export type OracleSigningEnvelope = z.infer<typeof envelopeSchema>;
export type VerifiedAttestation =
  | { readonly kind: 'feed_event'; readonly attestation: FeedEventAttestationV1 }
  | { readonly kind: 'position_invalidation'; readonly attestation: PositionInvalidationAttestationV1 }
  | { readonly kind: 'settlement'; readonly attestation: SettlementAttestationV1 }
  | { readonly kind: 'void'; readonly attestation: VoidAttestationV1 };

interface CommonJson {
  readonly clusterGenesisHash: string;
  readonly escrowProgramId: string;
  readonly marketPda: string;
  readonly marketDocumentHash: string;
  readonly fixtureId: string;
  readonly oracleSetEpoch: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly evidenceHash: string;
}

function restoreCommon(value: CommonJson) {
  return {
    clusterGenesisHash: hexToBytes(value.clusterGenesisHash),
    escrowProgramId: hexToBytes(value.escrowProgramId),
    marketPda: hexToBytes(value.marketPda),
    marketDocumentHash: hexToBytes(value.marketDocumentHash),
    fixtureId: BigInt(value.fixtureId),
    oracleSetEpoch: BigInt(value.oracleSetEpoch),
    issuedAt: BigInt(value.issuedAt),
    expiresAt: BigInt(value.expiresAt),
    evidenceHash: hexToBytes(value.evidenceHash),
  };
}

function restore(kind: OracleSigningEnvelope['kind'], value: unknown): VerifiedAttestation {
  switch (kind) {
    case 'feed_event': {
      const parsed = feed.parse(value);
      return { kind, attestation: {
        ...restoreCommon(parsed), eventKind: parsed.eventKind, eventEpoch: BigInt(parsed.eventEpoch),
        decidingSequence: BigInt(parsed.decidingSequence), observedAt: BigInt(parsed.observedAt),
      } };
    }
    case 'position_invalidation': {
      const parsed = invalidation.parse(value);
      return { kind, attestation: {
        ...restoreCommon(parsed), positionLotPda: hexToBytes(parsed.positionLotPda),
        lotNonce: BigInt(parsed.lotNonce), observedEventEpoch: BigInt(parsed.observedEventEpoch),
        invalidatedEventEpoch: BigInt(parsed.invalidatedEventEpoch),
        decidingSequence: BigInt(parsed.decidingSequence),
      } };
    }
    case 'settlement': {
      const parsed = settlement.parse(value);
      return { kind, attestation: {
        ...restoreCommon(parsed), outcome: parsed.outcome,
        decidingSequence: BigInt(parsed.decidingSequence), terminalPhase: parsed.terminalPhase,
        regulationScore: parsed.regulationScore, fullMatchScore: parsed.fullMatchScore,
        evidenceSequenceCommitment: hexToBytes(parsed.evidenceSequenceCommitment),
        normalizedEvidenceRoot: hexToBytes(parsed.normalizedEvidenceRoot),
      } };
    }
    case 'void': {
      const parsed = voidValue.parse(value);
      return { kind, attestation: {
        ...restoreCommon(parsed), reason: parsed.reason,
        decidingSequence: BigInt(parsed.decidingSequence),
      } };
    }
  }
}

function encode(request: VerifiedAttestation): Uint8Array {
  switch (request.kind) {
    case 'feed_event': return encodeFeedEventAttestationV1(request.attestation);
    case 'position_invalidation': return encodePositionInvalidationAttestationV1(request.attestation);
    case 'settlement': return encodeSettlementAttestationV1(request.attestation);
    case 'void': return encodeVoidAttestationV1(request.attestation);
  }
}

export function parseOracleSigningEnvelope(raw: unknown): {
  readonly envelope: OracleSigningEnvelope;
  readonly request: VerifiedAttestation;
  readonly canonicalBytes: Uint8Array;
} {
  const envelope = envelopeSchema.parse(raw);
  const request = restore(envelope.kind, envelope.attestationJson);
  const canonicalBytes = encode(request);
  const encodedBase64 = Buffer.from(canonicalBytes).toString('base64');
  const canonicalSha256Hex = createHash('sha256').update(canonicalBytes).digest('hex');
  if (
    encodedBase64 !== envelope.canonicalBytesBase64 ||
    canonicalSha256Hex !== envelope.canonicalSha256Hex ||
    bytesToHex(request.attestation.clusterGenesisHash) !== envelope.clusterGenesisHashHex ||
    bytesToHex(request.attestation.escrowProgramId) !== envelope.programIdHex ||
    bytesToHex(request.attestation.marketPda) !== envelope.marketPdaHex ||
    bytesToHex(request.attestation.marketDocumentHash) !== envelope.marketDocumentHashHex ||
    String(request.attestation.oracleSetEpoch) !== envelope.oracleSetEpoch ||
    bytesToHex(request.attestation.evidenceHash) !== envelope.evidenceHashHex
  ) throw new Error('oracle signing envelope binding mismatch');
  return { envelope, request, canonicalBytes };
}

export function journalKey(request: VerifiedAttestation): string {
  const market = bytesToHex(request.attestation.marketPda);
  const epoch = request.attestation.oracleSetEpoch;
  switch (request.kind) {
    case 'settlement':
    case 'void': return `terminal:v2:${market}:${epoch}`;
    case 'feed_event': return `feed:${market}:${request.attestation.eventEpoch}:${request.attestation.eventKind}`;
    case 'position_invalidation': return `lot:${market}:${bytesToHex(request.attestation.positionLotPda)}:${request.attestation.invalidatedEventEpoch}`;
  }
}

export function terminalSemanticDecisionHash(request: VerifiedAttestation): string {
  let canonicalDecision: Uint8Array;
  switch (request.kind) {
    case 'settlement':
      canonicalDecision = encodeSettlementAttestationV1({
        ...request.attestation,
        issuedAt: 0n,
        expiresAt: 1n,
      });
      break;
    case 'void':
      canonicalDecision = encodeVoidAttestationV1({
        ...request.attestation,
        issuedAt: 0n,
        expiresAt: 1n,
      });
      break;
    case 'feed_event':
    case 'position_invalidation':
      throw new Error('terminal semantic decision hash requires a terminal attestation');
  }
  return createHash('sha256').update(canonicalDecision).digest('hex');
}
