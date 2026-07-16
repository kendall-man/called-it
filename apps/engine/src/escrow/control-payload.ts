import {
  hexToBytes,
  type AttestationSignature,
  type FeedEventAttestationV1,
  type PositionInvalidationAttestationV1,
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
const feed = common.extend({
  eventKind: z.enum(['freeze', 'unfreeze', 'price_moving']),
  eventEpoch: z.string().regex(/^\d+$/), decidingSequence: z.string().regex(/^\d+$/),
  observedAt: z.string().regex(/^-?\d+$/),
});
const invalidation = common.extend({
  positionLotPda: z.string().regex(/^[0-9a-fA-F]{64}$/), lotNonce: z.string().regex(/^\d+$/),
  observedEventEpoch: z.string().regex(/^\d+$/), invalidatedEventEpoch: z.string().regex(/^\d+$/),
  decidingSequence: z.string().regex(/^\d+$/),
});
const schema = z.object({
  schemaVersion: z.literal(1),
  operation: z.enum(['freeze_market', 'unfreeze_market', 'invalidate_position_lot']),
  marketId: z.string().uuid(), marketPda: z.string().min(1),
  documentHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/), oracleEpoch: z.string().regex(/^\d+$/),
  feedOperatorAuthority: z.string().min(1), expectedEventEpoch: z.string().regex(/^\d+$/).optional(),
  owner: z.string().min(1).optional(), lotNonce: z.string().regex(/^\d+$/).optional(),
  positionLotPda: z.string().min(1).optional(),
  attestation: z.union([feed, invalidation]),
  signatures: z.array(z.object({
    publicKeyHex: z.string().regex(/^[0-9a-fA-F]{64}$/), signatureBase64: z.string().min(1),
  })).min(2),
}).strict();

export type EscrowControlPayload = z.infer<typeof schema>;

export function parseControlPayload(job: DurableEscrowRelayerJobRow): EscrowControlPayload {
  const value = schema.parse(job.payload);
  if (job.marketId !== value.marketId || job.custodyMode !== 'escrow') throw new TypeError('invalid escrow control payload');
  return value;
}

function restoreCommon(value: z.infer<typeof common>) {
  return {
    clusterGenesisHash: hexToBytes(value.clusterGenesisHash), escrowProgramId: hexToBytes(value.escrowProgramId),
    marketPda: hexToBytes(value.marketPda), marketDocumentHash: hexToBytes(value.marketDocumentHash),
    fixtureId: BigInt(value.fixtureId), oracleSetEpoch: BigInt(value.oracleSetEpoch),
    issuedAt: BigInt(value.issuedAt), expiresAt: BigInt(value.expiresAt), evidenceHash: hexToBytes(value.evidenceHash),
  };
}

export function restoreFeedAttestation(value: unknown): FeedEventAttestationV1 {
  const parsed = feed.parse(value);
  return {
    ...restoreCommon(parsed), eventKind: parsed.eventKind, eventEpoch: BigInt(parsed.eventEpoch),
    decidingSequence: BigInt(parsed.decidingSequence), observedAt: BigInt(parsed.observedAt),
  };
}

export function restoreInvalidationAttestation(value: unknown): PositionInvalidationAttestationV1 {
  const parsed = invalidation.parse(value);
  return {
    ...restoreCommon(parsed), positionLotPda: hexToBytes(parsed.positionLotPda), lotNonce: BigInt(parsed.lotNonce),
    observedEventEpoch: BigInt(parsed.observedEventEpoch), invalidatedEventEpoch: BigInt(parsed.invalidatedEventEpoch),
    decidingSequence: BigInt(parsed.decidingSequence),
  };
}

export function restoreControlSignatures(value: EscrowControlPayload['signatures']): readonly AttestationSignature[] {
  return value.map((signature) => ({
    publicKey: hexToBytes(signature.publicKeyHex),
    signature: Uint8Array.from(Buffer.from(signature.signatureBase64, 'base64')),
  }));
}
