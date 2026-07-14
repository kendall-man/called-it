import type {
  CreateEscrowSigningSessionInput,
  EscrowAsset,
  EscrowDb,
  EscrowSigningSessionResult,
} from '@calledit/db';
import type { MarketState, PositionSide } from '@calledit/escrow-sdk';
import type { Signer } from '@solana/web3.js';
import type { EscrowReadinessReason, EscrowReadinessReport } from './readiness.js';

// Migration 0024 currently has no placement-specific kind. Payload parsing
// isolates this compatibility lane from actual position-activation jobs.
export const PLACEMENT_RELAYER_STORAGE_KIND = 'position_activation' as const;

export interface EscrowPlacementMarket {
  readonly custodyMode: 'legacy' | 'escrow';
  readonly ownerProgramId: string;
  readonly marketPda: string;
  readonly marketId: string;
  readonly documentHashHex: string;
  readonly asset: EscrowAsset;
  readonly tokenMint: string | null;
  readonly ratioMilli: number;
  readonly eventEpoch: bigint;
  readonly oracleSetEpoch: bigint;
  readonly positionCutoffTimestamp: bigint;
  readonly state: MarketState;
}

export interface EscrowPlacementPosition {
  readonly ownerProgramId: string;
  readonly positionPda: string;
  readonly marketPda: string;
  readonly ownerPubkey: string;
  readonly side: PositionSide;
  readonly nextLotNonce: bigint;
  readonly totalPaidAmount: bigint;
  readonly claimed: boolean;
}

export interface EscrowPlacementChain {
  readMarket(marketPda: string): Promise<EscrowPlacementMarket | null>;
  readPosition(positionPda: string): Promise<EscrowPlacementPosition | null>;
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
  blockHeight(): Promise<bigint>;
  genesisHash(): Promise<string>;
  isBlockhashValid(blockhash: string): Promise<boolean>;
}

export interface EscrowPlacementDeployment {
  readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
  readonly genesisHash: string;
  readonly programId: string;
  readonly canonicalUsdcMint: string;
  readonly oracleSetEpoch: bigint;
  readonly custodyVersion: number;
  readonly minimumSolPosition: bigint;
  readonly maximumSolPosition: bigint;
  readonly minimumUsdcPosition: bigint;
  readonly maximumUsdcPosition: bigint;
}

export interface EscrowPlacementIdentity {
  readonly telegramUserId: number;
  readonly privyUserId: string;
  readonly privyWalletId: string;
  readonly ownerPubkey: string;
}

export interface EscrowPlacementAuthorization {
  readonly programId: string;
  readonly relayerFeePayer: string;
  readonly canonicalUsdcMint: string;
  readonly marketUuid: string;
  readonly marketPda: string;
  readonly marketDocumentHashHex: string;
  readonly side: PositionSide;
  readonly amount: bigint;
  readonly asset: EscrowAsset;
  readonly expectedRatioMilli: number;
  readonly expectedEventEpoch: bigint;
  readonly expectedLotNonce: bigint;
  readonly expiresAt: bigint;
  readonly genesisHash: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly messageHashHex: string;
}

export interface CreateEscrowPlacementInput extends EscrowPlacementIdentity {
  readonly marketId: string;
  readonly side: PositionSide;
  readonly amountAtomic: bigint;
  readonly ttlSeconds: number;
}

export type CreateEscrowPlacementResult =
  | { readonly kind: 'blocked'; readonly reasons: readonly EscrowReadinessReason[] }
  | {
      readonly kind: 'created';
      readonly token: string;
      readonly rawTransactionBase64: string;
      readonly authorization: EscrowPlacementAuthorization;
    };

export interface EscrowPlacementAuthorizationPresentation {
  readonly schemaVersion: 1;
  readonly programId: string;
  readonly relayerFeePayer: string;
  readonly canonicalUsdcMint: string;
  readonly marketUuid: string;
  readonly marketPda: string;
  readonly marketDocumentHashHex: string;
  readonly side: PositionSide;
  readonly amount: string;
  readonly asset: EscrowAsset;
  readonly expectedRatioMilli: string;
  readonly expectedEventEpoch: string;
  readonly expectedLotNonce: string;
  readonly expiresAt: string;
  readonly genesisHash: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: string;
  readonly messageHashHex: string;
}

export interface CreateDurableEscrowPlacementSessionInput extends CreateEscrowSigningSessionInput {
  readonly rawTransactionBase64: string;
  readonly authorization: EscrowPlacementAuthorizationPresentation;
}

export type GetDurableEscrowPlacementSessionResult =
  | {
      readonly ok: true;
      readonly ownerPubkey: string;
      readonly rawTransactionBase64: string;
      readonly authorization: EscrowPlacementAuthorizationPresentation;
    }
  | {
      readonly ok: false;
      readonly code: 'invalid_input' | 'session_not_found' | 'session_expired' | 'session_consumed';
    };

export interface EscrowPlacementDatabase {
  createSigningSession(input: CreateDurableEscrowPlacementSessionInput): Promise<EscrowSigningSessionResult>;
  getSigningSession(input: {
    readonly tokenHashHex: string;
    readonly nowIso: string;
  }): Promise<GetDurableEscrowPlacementSessionResult>;
  consumeSigningSession(
    input: Parameters<EscrowDb['consumeSigningSession']>[0],
  ): ReturnType<EscrowDb['consumeSigningSession']>;
  enqueueRelayerJob(
    input: Parameters<EscrowDb['enqueueRelayerJob']>[0],
  ): ReturnType<EscrowDb['enqueueRelayerJob']>;
}

export type EscrowPlacementPresentationResult =
  | {
      readonly kind: 'found';
      readonly schemaVersion: 1;
      readonly rawTransactionBase64: string;
      readonly authorization: EscrowPlacementAuthorizationPresentation;
    }
  | {
      readonly kind: 'rejected';
      readonly code: 'invalid_input' | 'session_not_found' | 'session_expired' | 'session_consumed';
    };

export interface AcceptEscrowPlacementInput extends EscrowPlacementIdentity {
  readonly marketId: string;
  readonly token: string;
  readonly rawTransactionBase64: string;
}

export type AcceptEscrowPlacementResult =
  | { readonly kind: 'accepted'; readonly duplicate: boolean; readonly jobCreated: boolean; readonly signature: string }
  | { readonly kind: 'rejected'; readonly code: 'invalid_input' | 'session_not_found' | 'session_expired' | 'session_consumed' | 'binding_mismatch' };

export type EscrowPlacementErrorCode =
  | 'network_mismatch'
  | 'market_not_found'
  | 'market_identity_mismatch'
  | 'market_unavailable'
  | 'asset_mismatch'
  | 'oracle_epoch_mismatch'
  | 'opposite_side_position'
  | 'position_identity_mismatch'
  | 'position_claimed'
  | 'amount_out_of_range'
  | 'invalid_session_ttl'
  | 'signing_session_rejected'
  | 'invalid_signed_transaction'
  | 'blockhash_invalid'
  | 'durable_enqueue_rejected';

export class EscrowPlacementError extends Error {
  readonly name = 'EscrowPlacementError';

  constructor(readonly code: EscrowPlacementErrorCode) {
    super(`escrow placement rejected: ${code}`);
  }
}

export interface EscrowPlacementServiceDependencies {
  readonly sponsor: Signer;
  readonly deployment: EscrowPlacementDeployment;
  readonly chain: EscrowPlacementChain;
  readonly readiness: () => Promise<EscrowReadinessReport>;
  readonly clock: () => { readonly unix: bigint; readonly iso: string };
  readonly tokenBytes?: () => Uint8Array;
}
