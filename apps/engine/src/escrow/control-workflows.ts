import type { EscrowDb } from '@calledit/db';
import {
  bytesToHex,
  deriveMarketPda,
  type AttestationSignature,
  type FeedEventAttestationV1,
  type PositionInvalidationAttestationV1,
} from '@calledit/escrow-sdk';
import { base58Decode } from '@calledit/solana';
import type { EscrowPlacementMarketLinkResult } from './placement-types.js';
import type { EscrowReadinessReport } from './readiness.js';

export interface EscrowControlDeployment {
  readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
  readonly genesisHash: string;
  readonly programId: string;
  readonly custodyVersion: number;
  readonly feedOperatorAuthority: string;
}

export type EscrowControlRequest =
  | {
      readonly operation: 'freeze_market';
      readonly marketPda: string;
      readonly expectedEventEpoch: bigint;
      readonly attestation: FeedEventAttestationV1;
      readonly signatures: readonly AttestationSignature[];
    }
  | {
      readonly operation: 'unfreeze_market';
      readonly marketPda: string;
      readonly attestation: FeedEventAttestationV1;
      readonly signatures: readonly AttestationSignature[];
    }
  | {
      readonly operation: 'invalidate_position_lot';
      readonly marketPda: string;
      readonly owner: string;
      readonly lotNonce: bigint;
      readonly positionLotPda: string;
      readonly attestation: PositionInvalidationAttestationV1;
      readonly signatures: readonly AttestationSignature[];
    };

export interface EscrowControlDatabase {
  getMarketLink(input: {
    readonly cluster: EscrowControlDeployment['cluster'];
    readonly genesisHash: string;
    readonly programId: string;
    readonly marketPda: string;
  }): Promise<EscrowPlacementMarketLinkResult>;
  enqueueRelayerJob(input: Omit<Parameters<EscrowDb['enqueueRelayerJob']>[0], 'kind'> & {
    readonly kind: 'freeze' | 'unfreeze' | 'position_invalidation';
  }): ReturnType<EscrowDb['enqueueRelayerJob']>;
}

function serializeAttestation(value: FeedEventAttestationV1 | PositionInvalidationAttestationV1) {
  return JSON.parse(JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item instanceof Uint8Array ? bytesToHex(item) : item));
}

function requireLink(
  link: EscrowPlacementMarketLinkResult,
  request: EscrowControlRequest,
  deployment: EscrowControlDeployment,
) {
  if (
    !link.ok || !link.found || link.custodyMode !== 'escrow' ||
    link.custodyVersion !== deployment.custodyVersion || link.cluster !== deployment.cluster ||
    link.genesisHash !== deployment.genesisHash || link.programId !== deployment.programId ||
    link.marketPda !== request.marketPda || link.commitment !== 'finalized' || link.projectionStale ||
    deriveMarketPda(deployment.programId, link.marketId).address !== request.marketPda ||
    link.chainState === 'closed'
  ) throw new TypeError('escrow control market identity mismatch');
  return link;
}

function validateAttestation(
  request: EscrowControlRequest,
  link: ReturnType<typeof requireLink>,
  deployment: EscrowControlDeployment,
): void {
  const value = request.attestation;
  const genesis = base58Decode(deployment.genesisHash);
  if (
    bytesToHex(value.clusterGenesisHash) !== bytesToHex(genesis) ||
    bytesToHex(value.escrowProgramId) !== bytesToHex(base58Decode(deployment.programId)) ||
    bytesToHex(value.marketPda) !== bytesToHex(base58Decode(link.marketPda)) ||
    bytesToHex(value.marketDocumentHash) !== link.documentHashHex.toLowerCase() ||
    value.oracleSetEpoch !== link.oracleEpoch || request.signatures.length < 2 ||
    new Set(request.signatures.map((signature) => bytesToHex(signature.publicKey))).size !== request.signatures.length ||
    request.signatures.some((signature) => signature.publicKey.length !== 32 || signature.signature.length !== 64)
  ) throw new TypeError('escrow control attestation mismatch');
  if (request.operation === 'freeze_market') {
    if (
      request.attestation.eventKind !== 'freeze' ||
      request.attestation.eventEpoch !== request.expectedEventEpoch + 1n
    ) throw new TypeError('escrow freeze epoch mismatch');
  } else if (request.operation === 'unfreeze_market') {
    if (request.attestation.eventKind !== 'unfreeze') {
      throw new TypeError('escrow unfreeze attestation mismatch');
    }
  } else if (
    request.attestation.lotNonce !== request.lotNonce ||
    bytesToHex(request.attestation.positionLotPda) !== bytesToHex(base58Decode(request.positionLotPda))
  ) throw new TypeError('escrow invalidation lot mismatch');
}

function kind(request: EscrowControlRequest): 'freeze' | 'unfreeze' | 'position_invalidation' {
  if (request.operation === 'freeze_market') return 'freeze';
  if (request.operation === 'unfreeze_market') return 'unfreeze';
  return 'position_invalidation';
}

export function createEscrowControlService(options: {
  readonly db: EscrowControlDatabase;
  readonly deployment: EscrowControlDeployment;
  readonly readiness: () => Promise<EscrowReadinessReport>;
  readonly clock: () => string;
}) {
  return {
    async enqueue(request: EscrowControlRequest) {
      const readiness = await options.readiness();
      if (readiness.status === 'not_ready') return { kind: 'blocked' as const, reasons: readiness.reasons };
      const link = requireLink(await options.db.getMarketLink({
        cluster: options.deployment.cluster,
        genesisHash: options.deployment.genesisHash,
        programId: options.deployment.programId,
        marketPda: request.marketPda,
      }), request, options.deployment);
      validateAttestation(request, link, options.deployment);
      const nowIso = options.clock();
      const operationKind = kind(request);
      const lot = request.operation === 'invalidate_position_lot'
        ? { owner: request.owner, lotNonce: String(request.lotNonce), positionLotPda: request.positionLotPda }
        : {};
      const payload = {
        schemaVersion: 1,
        operation: request.operation,
        marketId: link.marketId,
        marketPda: link.marketPda,
        documentHashHex: link.documentHashHex,
        oracleEpoch: String(link.oracleEpoch),
        feedOperatorAuthority: options.deployment.feedOperatorAuthority,
        ...(request.operation === 'freeze_market'
          ? { expectedEventEpoch: String(request.expectedEventEpoch) }
          : {}),
        ...lot,
        attestation: serializeAttestation(request.attestation),
        signatures: request.signatures.map((signature) => ({
          publicKeyHex: bytesToHex(signature.publicKey),
          signatureBase64: Buffer.from(signature.signature).toString('base64'),
        })),
      };
      const discriminator = request.operation === 'invalidate_position_lot'
        ? `${request.owner}:${request.lotNonce}`
        : bytesToHex(request.attestation.evidenceHash);
      const result = await options.db.enqueueRelayerJob({
        kind: operationKind,
        idempotencyKey: `escrow:v1:${operationKind}:${link.marketPda}:${discriminator}`,
        cluster: options.deployment.cluster,
        programId: options.deployment.programId,
        custodyMode: 'escrow',
        custodyVersion: options.deployment.custodyVersion,
        marketId: link.marketId,
        ownerPubkey: request.operation === 'invalidate_position_lot' ? request.owner : null,
        payload,
        dueAtIso: nowIso,
        maxAttempts: 12,
        nowIso,
      });
      if (!result.ok || !('created' in result)) throw new TypeError('escrow control enqueue rejected');
      return { kind: 'enqueued' as const, created: result.created, jobId: result.jobId };
    },
  };
}
