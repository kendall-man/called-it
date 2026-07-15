import { createHash } from 'node:crypto';
import {
  bytesToHex,
  type AttestationSignature,
  type FeedEventAttestationV1,
  type PositionInvalidationAttestationV1,
  type SettlementAttestationV1,
  type VoidAttestationV1,
} from '@calledit/escrow-sdk';
import { z } from 'zod';
import type { EscrowOracleAttestationPolicy, EscrowAttestationSigningRequest } from './attestation-signers.js';
import type { EscrowControlRequest } from './control-workflows.js';
import { restoreFeedAttestation, restoreInvalidationAttestation } from './control-payload.js';
import type { EscrowRecoveryRequest } from './recovery-workflows.js';
import { restoreSettlement, restoreVoid } from './recovery-payload.js';

export type EscrowUnsignedWorkflowRequest =
  | { readonly operation: 'freeze_market'; readonly marketPda: string; readonly expectedEventEpoch: bigint; readonly attestation: FeedEventAttestationV1 }
  | { readonly operation: 'unfreeze_market'; readonly marketPda: string; readonly attestation: FeedEventAttestationV1 }
  | { readonly operation: 'invalidate_position_lot'; readonly marketPda: string; readonly owner: string; readonly lotNonce: bigint; readonly positionLotPda: string; readonly attestation: PositionInvalidationAttestationV1 }
  | { readonly operation: 'settle_market'; readonly marketPda: string; readonly attestation: SettlementAttestationV1 }
  | { readonly operation: 'void_market'; readonly marketPda: string; readonly attestation: VoidAttestationV1 };

const attestation = z.record(z.string(), z.unknown());
const request = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('freeze_market'), marketPda: z.string(), expectedEventEpoch: z.string(), attestation }).strict(),
  z.object({ operation: z.literal('unfreeze_market'), marketPda: z.string(), attestation }).strict(),
  z.object({
    operation: z.literal('invalidate_position_lot'), marketPda: z.string(), owner: z.string(),
    lotNonce: z.string(), positionLotPda: z.string(), attestation,
  }).strict(),
  z.object({ operation: z.literal('settle_market'), marketPda: z.string(), attestation }).strict(),
  z.object({ operation: z.literal('void_market'), marketPda: z.string(), attestation }).strict(),
]);
const unsignedSchema = z.object({
  schemaVersion: z.literal(1),
  signingKind: z.enum(['feed_event', 'position_invalidation', 'settlement', 'void']),
  marketId: z.string().uuid(), marketPda: z.string(), documentHashHex: z.string().regex(/^[0-9a-f]{64}$/),
  oracleEpoch: z.string().regex(/^\d+$/), eventEpoch: z.string().regex(/^\d+$/), replay: z.boolean(),
  oraclePolicy: z.object({
    oracleSetEpoch: z.string().regex(/^\d+$/), signers: z.array(z.string()).length(3), threshold: z.literal(2),
  }).strict(),
  request,
}).strict();
const signatureSchema = z.object({
  publicKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
  signatureBase64: z.string().refine((value) => Buffer.from(value, 'base64').length === 64),
}).strict();
const signedSchema = z.object({
  schemaVersion: z.literal(1), unsignedPayloadHashHex: z.string().regex(/^[0-9a-f]{64}$/),
  signatures: z.array(signatureSchema).min(2),
}).strict();

export type EscrowUnsignedAttestationPayload = z.infer<typeof unsignedSchema>;
export type EscrowSignedAttestationPayload = z.infer<typeof signedSchema>;

function jsonRecord(value: object): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item instanceof Uint8Array ? bytesToHex(item) : item));
  return attestation.parse(parsed);
}

function signingKind(requestValue: EscrowUnsignedWorkflowRequest): EscrowUnsignedAttestationPayload['signingKind'] {
  switch (requestValue.operation) {
    case 'freeze_market':
    case 'unfreeze_market': return 'feed_event';
    case 'invalidate_position_lot': return 'position_invalidation';
    case 'settle_market': return 'settlement';
    case 'void_market': return 'void';
  }
}

export function createUnsignedAttestationPayload(input: {
  readonly marketId: string;
  readonly documentHashHex: string;
  readonly eventEpoch: bigint;
  readonly replay: boolean;
  readonly oraclePolicy: EscrowOracleAttestationPolicy;
  readonly request: EscrowUnsignedWorkflowRequest;
}): EscrowUnsignedAttestationPayload {
  const common = { operation: input.request.operation, marketPda: input.request.marketPda };
  const requestValue = input.request.operation === 'freeze_market'
    ? { ...common, expectedEventEpoch: String(input.request.expectedEventEpoch), attestation: jsonRecord(input.request.attestation) }
    : input.request.operation === 'invalidate_position_lot'
      ? {
          ...common, owner: input.request.owner, lotNonce: String(input.request.lotNonce),
          positionLotPda: input.request.positionLotPda, attestation: jsonRecord(input.request.attestation),
        }
      : { ...common, attestation: jsonRecord(input.request.attestation) };
  return unsignedSchema.parse({
    schemaVersion: 1, signingKind: signingKind(input.request), marketId: input.marketId,
    marketPda: input.request.marketPda, documentHashHex: input.documentHashHex.toLowerCase(),
    oracleEpoch: String(input.oraclePolicy.oracleSetEpoch), eventEpoch: String(input.eventEpoch), replay: input.replay,
    oraclePolicy: {
      oracleSetEpoch: String(input.oraclePolicy.oracleSetEpoch),
      signers: input.oraclePolicy.signers, threshold: input.oraclePolicy.threshold,
    },
    request: requestValue,
  });
}

export function parseUnsignedAttestationPayload(value: unknown): EscrowUnsignedAttestationPayload {
  return unsignedSchema.parse(value);
}

export function attestationPayloadHash(value: EscrowUnsignedAttestationPayload | EscrowSignedAttestationPayload): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function attestationSigningRequest(payload: EscrowUnsignedAttestationPayload): EscrowAttestationSigningRequest {
  switch (payload.signingKind) {
    case 'feed_event': return { kind: 'feed_event', attestation: restoreFeedAttestation(payload.request.attestation) };
    case 'position_invalidation': return { kind: 'position_invalidation', attestation: restoreInvalidationAttestation(payload.request.attestation) };
    case 'settlement': return { kind: 'settlement', attestation: restoreSettlement(payload.request.attestation) };
    case 'void': return { kind: 'void', attestation: restoreVoid(payload.request.attestation) };
  }
}

export function createSignedAttestationPayload(
  unsignedPayloadHashHex: string,
  signatures: readonly AttestationSignature[],
): EscrowSignedAttestationPayload {
  return signedSchema.parse({
    schemaVersion: 1, unsignedPayloadHashHex,
    signatures: signatures.map((value) => ({
      publicKeyHex: bytesToHex(value.publicKey), signatureBase64: Buffer.from(value.signature).toString('base64'),
    })),
  });
}

export function parseSignedAttestationPayload(
  value: unknown,
  unsignedPayloadHashHex: string,
): EscrowSignedAttestationPayload {
  const parsed = signedSchema.parse(value);
  if (parsed.unsignedPayloadHashHex !== unsignedPayloadHashHex) throw new TypeError('signed attestation payload mismatch');
  return parsed;
}

function signatures(payload: EscrowSignedAttestationPayload): readonly AttestationSignature[] {
  return payload.signatures.map((value) => ({
    publicKey: Uint8Array.from(Buffer.from(value.publicKeyHex, 'hex')),
    signature: Uint8Array.from(Buffer.from(value.signatureBase64, 'base64')),
  }));
}

export function restoreSignedWorkflowRequest(
  unsigned: EscrowUnsignedAttestationPayload,
  signed: EscrowSignedAttestationPayload,
): EscrowControlRequest | EscrowRecoveryRequest {
  const signedValues = signatures(signed);
  switch (unsigned.request.operation) {
    case 'freeze_market': return {
      operation: 'freeze_market', marketPda: unsigned.request.marketPda,
      expectedEventEpoch: BigInt(unsigned.request.expectedEventEpoch),
      attestation: restoreFeedAttestation(unsigned.request.attestation), signatures: signedValues,
    };
    case 'unfreeze_market': return {
      operation: 'unfreeze_market', marketPda: unsigned.request.marketPda,
      attestation: restoreFeedAttestation(unsigned.request.attestation), signatures: signedValues,
    };
    case 'invalidate_position_lot': return {
      operation: 'invalidate_position_lot', marketPda: unsigned.request.marketPda,
      owner: unsigned.request.owner, lotNonce: BigInt(unsigned.request.lotNonce),
      positionLotPda: unsigned.request.positionLotPda,
      attestation: restoreInvalidationAttestation(unsigned.request.attestation), signatures: signedValues,
    };
    case 'settle_market': return {
      operation: 'settle_market', marketPda: unsigned.request.marketPda,
      attestation: restoreSettlement(unsigned.request.attestation), signatures: signedValues,
    };
    case 'void_market': return {
      operation: 'void_market', marketPda: unsigned.request.marketPda,
      attestation: restoreVoid(unsigned.request.attestation), signatures: signedValues,
    };
  }
}
