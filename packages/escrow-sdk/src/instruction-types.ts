import type {
  FeedEventAttestationV1,
  PositionInvalidationAttestationV1,
  SettlementAttestationV1,
  VoidAttestationV1,
} from './attestations.js';
import type { PublicKeyInput } from './borsh.js';
import type { EscrowAsset, MarketDocumentV1, PositionSide } from './domain.js';

export interface InitializeConfigInstruction {
  readonly kind: 'initialize_config';
  readonly initializer: PublicKeyInput;
  readonly configAuthority: PublicKeyInput;
  readonly pauseAuthority: PublicKeyInput;
  readonly marketCreationAuthority: PublicKeyInput;
  readonly feedOperatorAuthority: PublicKeyInput;
  readonly relayerFeePayer: PublicKeyInput;
  readonly clusterGenesisHash: Uint8Array;
  readonly canonicalUsdcMint: PublicKeyInput;
  readonly residualRecipient: PublicKeyInput;
  readonly minimumSolPosition: bigint;
  readonly maximumSolPosition: bigint;
  readonly minimumUsdcPosition: bigint;
  readonly maximumUsdcPosition: bigint;
  readonly maximumMarketDurationSeconds: bigint;
  readonly maximumResolutionDelaySeconds: bigint;
  readonly allowedTokenProgram: PublicKeyInput;
}

export interface RotateOracleSetInstruction {
  readonly kind: 'rotate_oracle_set';
  readonly payer: PublicKeyInput;
  readonly configAuthority: PublicKeyInput;
  readonly currentOracleSet: PublicKeyInput;
  readonly epoch: bigint;
  readonly signers: readonly PublicKeyInput[];
  readonly signatureThreshold: number;
  readonly activationSlot: bigint;
  readonly retirementSlot: bigint | null;
}

export interface RotateConfigInstruction {
  readonly kind: 'rotate_config';
  readonly currentConfigAuthority: PublicKeyInput;
  readonly configAuthority: PublicKeyInput;
  readonly pauseAuthority: PublicKeyInput;
  readonly marketCreationAuthority: PublicKeyInput;
  readonly feedOperatorAuthority: PublicKeyInput;
  readonly relayerFeePayer: PublicKeyInput;
  readonly residualRecipient: PublicKeyInput;
  readonly minimumSolPosition: bigint;
  readonly maximumSolPosition: bigint;
  readonly minimumUsdcPosition: bigint;
  readonly maximumUsdcPosition: bigint;
  readonly maximumMarketDurationSeconds: bigint;
  readonly maximumResolutionDelaySeconds: bigint;
}

export interface SetPauseInstruction {
  readonly kind: 'set_pause';
  readonly authority: PublicKeyInput;
  readonly paused: boolean;
}

export interface InitializeMarketInstruction {
  readonly kind: 'initialize_market';
  readonly payer: PublicKeyInput;
  readonly marketCreationAuthority: PublicKeyInput;
  readonly canonicalUsdcMint: PublicKeyInput;
  readonly expectedClusterGenesisHash: Uint8Array;
  readonly document: MarketDocumentV1;
  readonly documentHash: Uint8Array;
}

export interface FreezeMarketInstruction {
  readonly kind: 'freeze_market';
  readonly feedOperatorAuthority: PublicKeyInput;
  readonly marketUuid: string;
  readonly expectedEventEpoch: bigint;
  readonly evidenceHash: Uint8Array;
}

export interface UnfreezeMarketInstruction {
  readonly kind: 'unfreeze_market';
  readonly marketUuid: string;
  readonly attestation: FeedEventAttestationV1;
}

export interface PlacePositionInstruction {
  readonly kind: 'place_position';
  readonly payer: PublicKeyInput;
  readonly owner: PublicKeyInput;
  readonly canonicalUsdcMint: PublicKeyInput;
  readonly marketUuid: string;
  readonly side: PositionSide;
  readonly amount: bigint;
  readonly expectedAsset: EscrowAsset;
  readonly expectedRatioMilli: number;
  readonly expectedMarketDocumentHash: Uint8Array;
  readonly expectedEventEpoch: bigint;
  readonly expectedLotNonce: bigint;
  readonly clientIntentHash: Uint8Array;
  readonly clientExpiryTimestamp: bigint;
}

export interface PositionLotInstructionBase {
  readonly marketUuid: string;
  readonly owner: PublicKeyInput;
  readonly lotNonce: bigint;
}

export interface ActivatePositionLotInstruction extends PositionLotInstructionBase {
  readonly kind: 'activate_position_lot';
  readonly expectedEventEpoch: bigint;
}

export interface InvalidatePositionLotInstruction extends PositionLotInstructionBase {
  readonly kind: 'invalidate_position_lot';
  readonly attestation: PositionInvalidationAttestationV1;
}

export interface SettleMarketInstruction {
  readonly kind: 'settle_market';
  readonly marketUuid: string;
  readonly attestation: SettlementAttestationV1;
}

export interface VoidMarketInstruction {
  readonly kind: 'void_market';
  readonly marketUuid: string;
  readonly attestation: VoidAttestationV1;
}

export interface OracleEpochMarketInstruction {
  readonly marketUuid: string;
  readonly oracleSetEpoch: bigint;
}

export interface TimeoutVoidInstruction {
  readonly kind: 'timeout_void';
  readonly marketUuid: string;
}

export interface PositionInstructionBase {
  readonly marketUuid: string;
  readonly owner: PublicKeyInput;
}

export interface ClaimPositionInstruction extends PositionInstructionBase {
  readonly kind: 'claim_position';
  readonly payer: PublicKeyInput;
  readonly asset: EscrowAsset;
  readonly canonicalUsdcMint: PublicKeyInput;
}

export interface CalculatePositionEntitlementInstruction extends PositionInstructionBase {
  readonly kind: 'calculate_position_entitlement';
}

export interface ClosePositionLotsInstruction extends PositionInstructionBase {
  readonly kind: 'close_position_lots';
  readonly rentRecipient: PublicKeyInput;
  readonly lotNonces: readonly bigint[];
}

export interface CloseMarketInstruction {
  readonly kind: 'close_market';
  readonly marketUuid: string;
  readonly asset: EscrowAsset;
  readonly canonicalUsdcMint: PublicKeyInput;
  readonly residualRecipient: PublicKeyInput;
}

export type EscrowInstructionRequest =
  | InitializeConfigInstruction
  | RotateConfigInstruction
  | RotateOracleSetInstruction
  | SetPauseInstruction
  | InitializeMarketInstruction
  | FreezeMarketInstruction
  | UnfreezeMarketInstruction
  | PlacePositionInstruction
  | ActivatePositionLotInstruction
  | InvalidatePositionLotInstruction
  | SettleMarketInstruction
  | VoidMarketInstruction
  | TimeoutVoidInstruction
  | CalculatePositionEntitlementInstruction
  | ClaimPositionInstruction
  | ClosePositionLotsInstruction
  | CloseMarketInstruction;
