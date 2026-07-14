import type { EscrowAddress } from './accounts.js';
import type { EscrowAsset, PositionSide, SettlementOutcome } from './domain.js';

export interface MarketInitializedEvent {
  readonly kind: 'MarketInitialized';
  readonly market: EscrowAddress;
  readonly marketUuid: string;
  readonly documentHash: Uint8Array;
  readonly asset: EscrowAsset;
  readonly vault: EscrowAddress;
  readonly residualRecipient: EscrowAddress;
}

export interface MarketFrozenEvent {
  readonly kind: 'MarketFrozen';
  readonly market: EscrowAddress;
  readonly eventEpoch: bigint;
}

export interface MarketUnfrozenEvent {
  readonly kind: 'MarketUnfrozen';
  readonly market: EscrowAddress;
  readonly eventEpoch: bigint;
}

export interface PositionPlacedEvent {
  readonly kind: 'PositionPlaced';
  readonly market: EscrowAddress;
  readonly owner: EscrowAddress;
  readonly lotNonce: bigint;
  readonly side: PositionSide;
  readonly amount: bigint;
  readonly pending: boolean;
  readonly eventEpoch: bigint;
  readonly clientIntentHash: Uint8Array;
}

export interface PositionActivatedEvent {
  readonly kind: 'PositionActivated';
  readonly market: EscrowAddress;
  readonly owner: EscrowAddress;
  readonly lotNonce: bigint;
}

export interface PositionInvalidatedEvent {
  readonly kind: 'PositionInvalidated';
  readonly market: EscrowAddress;
  readonly owner: EscrowAddress;
  readonly lotNonce: bigint;
  readonly evidenceHash: Uint8Array;
}

export interface MarketSettledEvent {
  readonly kind: 'MarketSettled';
  readonly market: EscrowAddress;
  readonly outcome: Exclude<SettlementOutcome, 'void'>;
  readonly evidenceHash: Uint8Array;
  readonly matchedBack: bigint;
  readonly matchedDoubt: bigint;
}

export interface MarketVoidedEvent {
  readonly kind: 'MarketVoided';
  readonly market: EscrowAddress;
  readonly evidenceHash: Uint8Array | null;
  readonly timeout: boolean;
}

export interface PositionClaimedEvent {
  readonly kind: 'PositionClaimed';
  readonly market: EscrowAddress;
  readonly owner: EscrowAddress;
  readonly amount: bigint;
}

export interface MarketClosedEvent {
  readonly kind: 'MarketClosed';
  readonly market: EscrowAddress;
  readonly dustAmount: bigint;
}

export type EscrowProgramEvent =
  | MarketInitializedEvent
  | MarketFrozenEvent
  | MarketUnfrozenEvent
  | PositionPlacedEvent
  | PositionActivatedEvent
  | PositionInvalidatedEvent
  | MarketSettledEvent
  | MarketVoidedEvent
  | PositionClaimedEvent
  | MarketClosedEvent;
