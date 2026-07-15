import type { EscrowDb } from '@calledit/db';
import {
  bytesToHex,
  deriveMarketPda,
  derivePositionLotPda,
  deriveUserPositionPda,
  type MarketAccount,
  type PositionLotAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import type { DecodedEscrowAccount } from './solana-accounts.js';
import type { EscrowPlacementMarketLinkResult } from './placement-types.js';
import type { EscrowReadinessReport } from './readiness.js';
import { createEscrowJobIdempotencyKey } from './job-state.js';

export interface EscrowPositionActivationDeployment {
  readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
  readonly genesisHash: string;
  readonly programId: string;
  readonly custodyVersion: number;
  readonly relayerFeePayer: string;
}

export interface EscrowPositionActivationChain {
  genesisHash(): Promise<string>;
  market(address: string): Promise<DecodedEscrowAccount<MarketAccount> | null>;
  position(address: string): Promise<DecodedEscrowAccount<UserPositionAccount> | null>;
  lot(address: string): Promise<DecodedEscrowAccount<PositionLotAccount> | null>;
}

export interface EscrowPositionActivationDatabase {
  getMarketLink(input: {
    readonly cluster: EscrowPositionActivationDeployment['cluster'];
    readonly genesisHash: string;
    readonly programId: string;
    readonly marketPda: string;
  }): Promise<EscrowPlacementMarketLinkResult>;
  enqueueRelayerJob(input: Omit<Parameters<EscrowDb['enqueueRelayerJob']>[0], 'kind'> & {
    readonly kind: 'position_activation';
  }): ReturnType<EscrowDb['enqueueRelayerJob']>;
}

export interface ScheduleEscrowPositionActivationInput {
  readonly marketPda: string;
  readonly owner: string;
  readonly lotNonce: bigint;
  readonly expectedEventEpoch: bigint;
}

export type ScheduleEscrowPositionActivationResult =
  | { readonly kind: 'blocked'; readonly reasons: readonly string[] }
  | { readonly kind: 'already_active' }
  | { readonly kind: 'enqueued'; readonly created: boolean; readonly jobId: string | null };

export type EscrowPositionActivationErrorCode =
  | 'invalid_request'
  | 'deployment_mismatch'
  | 'market_identity_mismatch'
  | 'market_unavailable'
  | 'position_identity_mismatch'
  | 'lot_identity_mismatch'
  | 'stale_epoch'
  | 'lot_invalidated'
  | 'enqueue_rejected';

export class EscrowPositionActivationError extends Error {
  readonly name = 'EscrowPositionActivationError';

  constructor(readonly code: EscrowPositionActivationErrorCode) {
    super(`escrow position activation rejected: ${code}`);
  }
}

function requireLink(
  value: EscrowPlacementMarketLinkResult,
  input: ScheduleEscrowPositionActivationInput,
  deployment: EscrowPositionActivationDeployment,
) {
  if (
    !value.ok || !value.found || value.custodyMode !== 'escrow' ||
    value.custodyVersion !== deployment.custodyVersion || value.cluster !== deployment.cluster ||
    value.genesisHash !== deployment.genesisHash || value.programId !== deployment.programId ||
    value.marketPda !== input.marketPda || value.commitment !== 'finalized' || value.projectionStale ||
    deriveMarketPda(deployment.programId, value.marketId).address !== input.marketPda
  ) throw new EscrowPositionActivationError('market_identity_mismatch');
  return value;
}

function exactAccount<T>(
  account: DecodedEscrowAccount<T> | null,
  address: string,
  deployment: EscrowPositionActivationDeployment,
  code: 'market_identity_mismatch' | 'position_identity_mismatch' | 'lot_identity_mismatch',
): DecodedEscrowAccount<T> {
  if (
    account === null || account.address !== address ||
    account.ownerProgramId !== deployment.programId
  ) throw new EscrowPositionActivationError(code);
  return account;
}

function activationDueAt(timestamp: bigint): string {
  const milliseconds = timestamp * 1_000n;
  if (timestamp < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EscrowPositionActivationError('lot_identity_mismatch');
  }
  const date = new Date(Number(milliseconds));
  if (!Number.isFinite(date.getTime())) throw new EscrowPositionActivationError('lot_identity_mismatch');
  return date.toISOString();
}

export function createEscrowPositionActivationService(options: {
  readonly db: EscrowPositionActivationDatabase;
  readonly chain: EscrowPositionActivationChain;
  readonly deployment: EscrowPositionActivationDeployment;
  readonly readiness: () => Promise<EscrowReadinessReport>;
  readonly clock: () => string;
}) {
  return {
    async schedule(input: ScheduleEscrowPositionActivationInput): Promise<ScheduleEscrowPositionActivationResult> {
      if (input.lotNonce < 0n || input.expectedEventEpoch < 0n) {
        throw new EscrowPositionActivationError('invalid_request');
      }
      let positionPda: string;
      let lotPda: string;
      try {
        positionPda = deriveUserPositionPda(
          options.deployment.programId, input.marketPda, input.owner,
        ).address;
        lotPda = derivePositionLotPda(
          options.deployment.programId, input.marketPda, input.owner, input.lotNonce,
        ).address;
      } catch {
        throw new EscrowPositionActivationError('invalid_request');
      }
      const readiness = await options.readiness();
      if (readiness.status === 'not_ready') return { kind: 'blocked', reasons: readiness.reasons };
      const [genesisHash, linkValue, marketValue, positionValue, lotValue] = await Promise.all([
        options.chain.genesisHash(),
        options.db.getMarketLink({
          cluster: options.deployment.cluster,
          genesisHash: options.deployment.genesisHash,
          programId: options.deployment.programId,
          marketPda: input.marketPda,
        }),
        options.chain.market(input.marketPda),
        options.chain.position(positionPda),
        options.chain.lot(lotPda),
      ]);
      if (genesisHash !== options.deployment.genesisHash) {
        throw new EscrowPositionActivationError('deployment_mismatch');
      }
      const link = requireLink(linkValue, input, options.deployment);
      const market = exactAccount(marketValue, input.marketPda, options.deployment, 'market_identity_mismatch');
      const position = exactAccount(positionValue, positionPda, options.deployment, 'position_identity_mismatch');
      const lot = exactAccount(lotValue, lotPda, options.deployment, 'lot_identity_mismatch');
      if (
        market.value.marketUuid !== link.marketId ||
        bytesToHex(market.value.marketDocumentHash) !== link.documentHashHex.toLowerCase() ||
        market.value.oracleSetEpoch !== link.oracleEpoch || market.value.asset !== link.asset ||
        market.value.tokenMint !== link.mintPubkey || market.value.vault !== link.vaultPda ||
        BigInt(market.value.ratioMilli) !== link.ratioMilli || market.value.state !== link.chainState
      ) throw new EscrowPositionActivationError('market_identity_mismatch');
      if (market.value.eventEpoch !== input.expectedEventEpoch || link.eventEpoch !== input.expectedEventEpoch) {
        throw new EscrowPositionActivationError('stale_epoch');
      }
      if (market.value.state !== 'open' && market.value.state !== 'frozen') {
        throw new EscrowPositionActivationError('market_unavailable');
      }
      if (
        position.value.market !== input.marketPda || position.value.owner !== input.owner ||
        position.value.claimed || position.value.nextLotNonce <= input.lotNonce
      ) throw new EscrowPositionActivationError('position_identity_mismatch');
      if (
        lot.value.market !== input.marketPda || lot.value.owner !== input.owner ||
        lot.value.nonce !== input.lotNonce || lot.value.side !== position.value.side ||
        lot.value.amount <= 0n || lot.value.observedEventEpoch !== input.expectedEventEpoch ||
        lot.value.activationTimestamp === null || position.value.pendingAmount < lot.value.amount
      ) throw new EscrowPositionActivationError('lot_identity_mismatch');
      const marketPending = lot.value.side === 'back'
        ? market.value.pendingBackTotal
        : market.value.pendingDoubtTotal;
      if (marketPending < lot.value.amount) throw new EscrowPositionActivationError('lot_identity_mismatch');
      if (lot.value.state === 'voided' || lot.value.invalidationEvidenceHash !== null) {
        throw new EscrowPositionActivationError('lot_invalidated');
      }
      if (lot.value.state === 'active') return { kind: 'already_active' };
      if (lot.value.state !== 'pending') throw new EscrowPositionActivationError('lot_identity_mismatch');

      const nowIso = options.clock();
      if (!Number.isFinite(Date.parse(nowIso))) throw new EscrowPositionActivationError('invalid_request');
      const idempotencyKey = createEscrowJobIdempotencyKey({
        kind: 'position_activation', programId: options.deployment.programId,
        marketPda: input.marketPda, owner: input.owner,
        lotNonce: input.lotNonce, eventEpoch: input.expectedEventEpoch,
      });
      const result = await options.db.enqueueRelayerJob({
        kind: 'position_activation', idempotencyKey,
        cluster: options.deployment.cluster, programId: options.deployment.programId,
        custodyMode: 'escrow', custodyVersion: options.deployment.custodyVersion,
        marketId: link.marketId, ownerPubkey: input.owner,
        payload: {
          schemaVersion: 1, operation: 'activate_position_lot',
          cluster: options.deployment.cluster, genesisHash: options.deployment.genesisHash,
          programId: options.deployment.programId, custodyVersion: options.deployment.custodyVersion,
          relayerFeePayer: options.deployment.relayerFeePayer,
          marketId: link.marketId, marketPda: input.marketPda,
          documentHashHex: link.documentHashHex.toLowerCase(),
          positionPda, positionLotPda: lotPda, owner: input.owner,
          lotNonce: String(input.lotNonce), expectedEventEpoch: String(input.expectedEventEpoch),
          activationTimestamp: String(lot.value.activationTimestamp),
        },
        dueAtIso: activationDueAt(lot.value.activationTimestamp),
        maxAttempts: 12, nowIso,
      });
      if (!result.ok) throw new EscrowPositionActivationError('enqueue_rejected');
      if ('created' in result) return { kind: 'enqueued', created: result.created, jobId: result.jobId };
      return { kind: 'enqueued', created: false, jobId: null };
    },
  };
}
