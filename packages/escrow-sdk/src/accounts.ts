import type { EscrowAsset, PositionSide, SettlementOutcome } from './domain.js';

export type EscrowAddress = string;
export type MarketState = 'opening' | 'open' | 'frozen' | 'settled' | 'voided' | 'closed';
export type PositionLotState = 'pending' | 'active' | 'voided';

export interface ProtocolConfigAccount {
  readonly version: number;
  readonly bump: number;
  readonly paused: boolean;
  readonly configAuthority: EscrowAddress;
  readonly pauseAuthority: EscrowAddress;
  readonly marketCreationAuthority: EscrowAddress;
  readonly oracleSet: EscrowAddress;
  readonly relayerFeePayer: EscrowAddress;
  readonly clusterGenesisHash: Uint8Array;
  readonly canonicalUsdcMint: EscrowAddress;
  readonly residualRecipient: EscrowAddress;
  readonly minimumSolPosition: bigint;
  readonly maximumSolPosition: bigint;
  readonly minimumUsdcPosition: bigint;
  readonly maximumUsdcPosition: bigint;
  readonly maximumMarketDurationSeconds: bigint;
  readonly maximumResolutionDelaySeconds: bigint;
  readonly allowedTokenProgram: EscrowAddress;
}

export interface OracleSetAccount {
  readonly version: number;
  readonly bump: number;
  readonly epoch: bigint;
  readonly signers: readonly EscrowAddress[];
  readonly signatureThreshold: number;
  readonly activationSlot: bigint;
  readonly retirementSlot: bigint | null;
}

export interface MarketAccount {
  readonly version: number;
  readonly bump: number;
  readonly marketUuid: string;
  readonly fixtureId: bigint;
  readonly claimSpecificationHash: Uint8Array;
  readonly displayTermsHash: Uint8Array;
  readonly oddsMessageHash: Uint8Array;
  readonly marketDocumentHash: Uint8Array;
  readonly quoteTimestamp: bigint;
  readonly probabilityPpm: number;
  readonly ratioMilli: number;
  readonly asset: EscrowAsset;
  readonly tokenMint: EscrowAddress | null;
  readonly feeBps: number;
  readonly state: MarketState;
  readonly createdTimestamp: bigint;
  readonly positionCutoffTimestamp: bigint;
  readonly resolutionDeadline: bigint;
  readonly oracleSetEpoch: bigint;
  readonly eventEpoch: bigint;
  readonly activeBackTotal: bigint;
  readonly activeDoubtTotal: bigint;
  readonly pendingBackTotal: bigint;
  readonly pendingDoubtTotal: bigint;
  readonly finalMatchedBackTotal: bigint;
  readonly finalMatchedDoubtTotal: bigint;
  readonly settlementOutcome: Exclude<SettlementOutcome, 'void'> | null;
  readonly settlementEvidenceHash: Uint8Array | null;
  readonly positionCount: bigint;
  readonly claimedPositionCount: bigint;
  readonly vault: EscrowAddress;
  readonly vaultBump: number;
  /** Pinned from ProtocolConfig at creation; never supplied to close_market. */
  readonly residualRecipient: EscrowAddress;
}

export interface UserPositionAccount {
  readonly version: number;
  readonly bump: number;
  readonly market: EscrowAddress;
  readonly owner: EscrowAddress;
  readonly side: PositionSide;
  readonly activeAmount: bigint;
  readonly pendingAmount: bigint;
  readonly refundableAmount: bigint;
  readonly nextLotNonce: bigint;
  readonly claimed: boolean;
  readonly totalPaidAmount: bigint;
  readonly createdSlot: bigint;
  readonly updatedSlot: bigint;
}

export interface PositionLotAccount {
  readonly version: number;
  readonly bump: number;
  readonly market: EscrowAddress;
  readonly owner: EscrowAddress;
  readonly nonce: bigint;
  readonly side: PositionSide;
  readonly amount: bigint;
  readonly placedTimestamp: bigint;
  readonly placedSlot: bigint;
  readonly observedEventEpoch: bigint;
  readonly state: PositionLotState;
  readonly activationTimestamp: bigint | null;
  readonly invalidationEvidenceHash: Uint8Array | null;
}
