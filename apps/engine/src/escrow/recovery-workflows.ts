import { createHash } from 'node:crypto';
import type { EscrowDb } from '@calledit/db';
import {
  bytesToHex,
  deriveMarketPda,
  type AttestationSignature,
  type SettlementAttestationV1,
  type VoidAttestationV1,
} from '@calledit/escrow-sdk';
import { base58Decode } from '@calledit/solana';
import type { EscrowPlacementMarketLinkResult } from './placement-types.js';
import type { EscrowReadinessReport } from './readiness.js';

export type EscrowRecoveryJobKind =
  | 'settlement_submission'
  | 'timeout_monitoring'
  | 'auto_claim'
  | 'account_close';

export const MAX_CLOSE_POSITION_LOTS_PER_TRANSACTION = 8;

export type EscrowRecoveryRequest =
  | { readonly operation: 'settle_market'; readonly marketPda: string; readonly attestation: SettlementAttestationV1; readonly signatures: readonly AttestationSignature[] }
  | { readonly operation: 'void_market'; readonly marketPda: string; readonly attestation: VoidAttestationV1; readonly signatures: readonly AttestationSignature[] }
  | { readonly operation: 'timeout_void'; readonly marketPda: string }
  | { readonly operation: 'calculate_position_entitlement'; readonly marketPda: string; readonly owner: string }
  | { readonly operation: 'claim_position_for'; readonly marketPda: string; readonly owner: string }
  | { readonly operation: 'close_position_lots'; readonly marketPda: string; readonly owner: string; readonly lotNonces: readonly bigint[] }
  | { readonly operation: 'close_position'; readonly marketPda: string; readonly owner: string }
  | { readonly operation: 'close_market'; readonly marketPda: string };

export interface EscrowRecoveryDeployment {
  readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
  readonly genesisHash: string;
  readonly programId: string;
  readonly canonicalUsdcMint: string;
  readonly relayerFeePayer: string;
  readonly residualRecipient: string;
  readonly custodyVersion: number;
}

export interface EscrowRecoveryDatabase {
  getMarketLink(input: {
    readonly cluster: EscrowRecoveryDeployment['cluster'];
    readonly genesisHash: string;
    readonly programId: string;
    readonly marketPda: string;
  }): Promise<EscrowPlacementMarketLinkResult>;
  enqueueRelayerJob(input: Omit<Parameters<EscrowDb['enqueueRelayerJob']>[0], 'kind'> & {
    readonly kind: EscrowRecoveryJobKind;
  }): ReturnType<EscrowDb['enqueueRelayerJob']>;
}

export type EnqueueEscrowRecoveryResult =
  | { readonly kind: 'blocked'; readonly reasons: readonly string[] }
  | { readonly kind: 'enqueued'; readonly created: boolean; readonly jobId: string };

export class EscrowRecoveryError extends Error {
  readonly name = 'EscrowRecoveryError';

  constructor(readonly code: 'market_unavailable' | 'market_identity_mismatch' | 'attestation_mismatch' | 'invalid_request' | 'enqueue_rejected') {
    super(`escrow recovery rejected: ${code}`);
  }
}

function requireLink(
  link: EscrowPlacementMarketLinkResult,
  marketPda: string,
  deployment: EscrowRecoveryDeployment,
) {
  if (
    !link.ok || !link.found || link.custodyMode !== 'escrow' ||
    link.custodyVersion !== deployment.custodyVersion || link.cluster !== deployment.cluster ||
    link.genesisHash !== deployment.genesisHash || link.programId !== deployment.programId ||
    link.marketPda !== marketPda || link.commitment !== 'finalized' || link.projectionStale ||
    deriveMarketPda(deployment.programId, link.marketId).address !== marketPda
  ) throw new EscrowRecoveryError('market_identity_mismatch');
  return link;
}

function assertAttestation(
  attestation: SettlementAttestationV1 | VoidAttestationV1,
  signatures: readonly AttestationSignature[],
  link: ReturnType<typeof requireLink>,
  deployment: EscrowRecoveryDeployment,
): void {
  const genesis = base58Decode(deployment.genesisHash);
  if (
    genesis.length !== 32 || bytesToHex(attestation.clusterGenesisHash) !== bytesToHex(genesis) ||
    bytesToHex(attestation.escrowProgramId) !== bytesToHex(base58Decode(deployment.programId)) ||
    bytesToHex(attestation.marketPda) !== bytesToHex(base58Decode(link.marketPda)) ||
    bytesToHex(attestation.marketDocumentHash) !== link.documentHashHex.toLowerCase() ||
    attestation.oracleSetEpoch !== link.oracleEpoch || signatures.length === 0
  ) throw new EscrowRecoveryError('attestation_mismatch');
  const signers = new Set<string>();
  for (const signature of signatures) {
    if (signature.publicKey.length !== 32 || signature.signature.length !== 64) {
      throw new EscrowRecoveryError('attestation_mismatch');
    }
    signers.add(bytesToHex(signature.publicKey));
  }
  if (signers.size !== signatures.length) throw new EscrowRecoveryError('attestation_mismatch');
}

function jobKind(operation: EscrowRecoveryRequest['operation']): EscrowRecoveryJobKind {
  if (operation === 'settle_market' || operation === 'void_market') return 'settlement_submission';
  if (operation === 'timeout_void') return 'timeout_monitoring';
  if (operation === 'calculate_position_entitlement' || operation === 'claim_position_for') return 'auto_claim';
  return 'account_close';
}

function owner(request: EscrowRecoveryRequest): string | null {
  return 'owner' in request ? request.owner : null;
}

function payload(request: EscrowRecoveryRequest, link: ReturnType<typeof requireLink>) {
  const common = {
    schemaVersion: 1, operation: request.operation, marketId: link.marketId,
    marketPda: link.marketPda, documentHashHex: link.documentHashHex,
    oracleEpoch: String(link.oracleEpoch), asset: link.asset, mintPubkey: link.mintPubkey,
  };
  if (request.operation === 'settle_market' || request.operation === 'void_market') {
    return {
      ...common,
      attestation: JSON.parse(JSON.stringify(request.attestation, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value instanceof Uint8Array ? bytesToHex(value) : value)),
      signatures: request.signatures.map((value) => ({
        publicKeyHex: bytesToHex(value.publicKey), signatureBase64: Buffer.from(value.signature).toString('base64'),
      })),
    };
  }
  if (request.operation === 'close_position_lots') {
    if (
      request.lotNonces.length === 0 ||
      request.lotNonces.length > MAX_CLOSE_POSITION_LOTS_PER_TRANSACTION ||
      request.lotNonces.some((nonce, index) => (
        nonce < 0n || (index > 0 && request.lotNonces[index - 1] !== nonce + 1n)
      ))
    ) throw new EscrowRecoveryError('invalid_request');
    return { ...common, owner: request.owner, lotNonces: request.lotNonces.map(String) };
  }
  return 'owner' in request ? { ...common, owner: request.owner } : common;
}

function idempotencyKey(request: EscrowRecoveryRequest, link: ReturnType<typeof requireLink>): string {
  let discriminator: string;
  if (request.operation === 'settle_market' || request.operation === 'void_market') {
    discriminator = bytesToHex(request.attestation.evidenceHash);
  } else if (request.operation === 'close_position_lots') {
    const batchHash = createHash('sha256')
      .update(request.lotNonces.map(String).join(','))
      .digest('hex');
    discriminator = `${request.owner}:${batchHash}`;
  } else {
    discriminator = 'owner' in request ? request.owner : link.marketPda;
  }
  return `escrow:v1:${jobKind(request.operation)}:${request.operation}:${link.marketPda}:${discriminator}`;
}

export function createEscrowRecoveryService(options: {
  readonly db: EscrowRecoveryDatabase;
  readonly deployment: EscrowRecoveryDeployment;
  readonly readiness: () => Promise<EscrowReadinessReport>;
  readonly clock: () => string;
}) {
  return {
    async enqueue(request: EscrowRecoveryRequest): Promise<EnqueueEscrowRecoveryResult> {
      const readiness = await options.readiness();
      const terminalSubmission = request.operation === 'settle_market' || request.operation === 'void_market';
      const projectionOnlyDelay = readiness.status === 'not_ready' && readiness.reasons.every((reason) => (
        reason === 'indexer_unavailable' || reason === 'indexer_lagging'
      ));
      // A terminal attestation is already bound to a finalized market link and
      // independently verified by the oracle quorum below. A slow projection
      // must delay the success announcement, not the terminal transaction that
      // the projection is waiting to observe. Every other readiness failure
      // remains fail-closed.
      if (readiness.status === 'not_ready' && !(terminalSubmission && projectionOnlyDelay)) {
        return { kind: 'blocked', reasons: readiness.reasons };
      }
      const result = await options.db.getMarketLink({ ...options.deployment, marketPda: request.marketPda });
      const link = requireLink(result, request.marketPda, options.deployment);
      if (link.chainState === 'closed') throw new EscrowRecoveryError('market_unavailable');
      if (request.operation === 'settle_market' || request.operation === 'void_market') {
        assertAttestation(request.attestation, request.signatures, link, options.deployment);
      }
      const nowIso = options.clock();
      const enqueued = await options.db.enqueueRelayerJob({
        kind: jobKind(request.operation), idempotencyKey: idempotencyKey(request, link),
        cluster: options.deployment.cluster, programId: options.deployment.programId,
        custodyMode: 'escrow', custodyVersion: options.deployment.custodyVersion,
        marketId: link.marketId, ownerPubkey: owner(request), payload: payload(request, link),
        dueAtIso: nowIso, maxAttempts: 12, nowIso,
      });
      if (!enqueued.ok || !('created' in enqueued)) throw new EscrowRecoveryError('enqueue_rejected');
      return { kind: 'enqueued', created: enqueued.created, jobId: enqueued.jobId };
    },
  };
}
