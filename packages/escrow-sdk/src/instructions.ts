import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type {
  FeedEventAttestationV1,
  PositionInvalidationAttestationV1,
  SettlementAttestationV1,
  VoidAttestationV1,
} from './attestations.js';
import type { EscrowAddress } from './accounts.js';
import type { EscrowAsset, MarketDocumentV1, PositionSide } from './domain.js';

export interface InitializeConfigInstruction {
  readonly kind: 'initialize_config';
  readonly configAuthority: EscrowAddress;
  readonly pauseAuthority: EscrowAddress;
  readonly marketCreationAuthority: EscrowAddress;
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

export interface RotateOracleSetInstruction {
  readonly kind: 'rotate_oracle_set';
  readonly epoch: bigint;
  readonly signers: readonly EscrowAddress[];
  readonly signatureThreshold: number;
  readonly activationSlot: bigint;
  readonly retirementSlot: bigint | null;
}

export interface SetPauseInstruction {
  readonly kind: 'set_pause';
  readonly paused: boolean;
}

export interface InitializeMarketInstruction {
  readonly kind: 'initialize_market';
  readonly document: MarketDocumentV1;
  readonly documentHash: Uint8Array;
}

export interface FreezeMarketInstruction {
  readonly kind: 'freeze_market';
}

export interface UnfreezeMarketInstruction {
  readonly kind: 'unfreeze_market';
  readonly attestation: FeedEventAttestationV1;
}

export interface PlacePositionInstruction {
  readonly kind: 'place_position';
  readonly marketUuid: string;
  readonly side: PositionSide;
  readonly amount: bigint;
  readonly expectedAsset: EscrowAsset;
  readonly expectedRatioMilli: number;
  readonly expectedEventEpoch: bigint;
  readonly expectedLotNonce: bigint;
  readonly clientIntentHash: Uint8Array;
  readonly clientExpiryTimestamp: bigint;
}

export interface ActivatePositionLotInstruction {
  readonly kind: 'activate_position_lot';
  readonly lotNonce: bigint;
}

export interface InvalidatePositionLotInstruction {
  readonly kind: 'invalidate_position_lot';
  readonly attestation: PositionInvalidationAttestationV1;
}

export interface SettleMarketInstruction {
  readonly kind: 'settle_market';
  readonly attestation: SettlementAttestationV1;
  readonly signerPublicKeys: readonly Uint8Array[];
}

export interface VoidMarketInstruction {
  readonly kind: 'void_market';
  readonly attestation: VoidAttestationV1;
  readonly signerPublicKeys: readonly Uint8Array[];
}

export interface TimeoutVoidInstruction {
  readonly kind: 'timeout_void';
}

export interface ClaimPositionInstruction {
  readonly kind: 'claim_position';
}

export interface ClosePositionLotsInstruction {
  readonly kind: 'close_position_lots';
  readonly lotNonces: readonly bigint[];
}

export interface CloseMarketInstruction {
  readonly kind: 'close_market';
}

export type EscrowInstructionRequest =
  | InitializeConfigInstruction
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
  | ClaimPositionInstruction
  | ClosePositionLotsInstruction
  | CloseMarketInstruction;

export function instructionRequest<const T extends EscrowInstructionRequest>(request: T): T {
  return request;
}

export class EscrowIdlUnavailableError extends Error {
  constructor() {
    super('escrow instruction materialization is unavailable until the generated program IDL adapter is supplied');
    this.name = 'EscrowIdlUnavailableError';
  }
}

export interface EscrowInstructionAdapter {
  materialize(request: EscrowInstructionRequest, programId: PublicKey): TransactionInstruction;
}

export interface MaterializeInstructionOptions {
  readonly programId: PublicKey;
  readonly adapter?: EscrowInstructionAdapter;
}

export function materializeInstruction(
  request: EscrowInstructionRequest,
  options: MaterializeInstructionOptions,
): TransactionInstruction {
  if (options.adapter === undefined) throw new EscrowIdlUnavailableError();
  return options.adapter.materialize(request, options.programId);
}
