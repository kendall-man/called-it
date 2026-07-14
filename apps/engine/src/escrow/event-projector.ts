import {
  bytesToHex,
  deriveUsdcVaultAddress,
  type EscrowProgramEvent,
  type MarketAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import type { EscrowFinalizedProjection } from './finalized-indexer.js';
import type {
  DecodedEscrowAccount,
  SolanaEscrowAccountReader,
} from './solana-accounts.js';

export interface EscrowEventProjectionContext {
  readonly signature: string;
  readonly instructionIndex: number;
  readonly slot: bigint;
}

export interface EscrowEventProjector {
  project(
    event: EscrowProgramEvent,
    context: EscrowEventProjectionContext,
  ): Promise<EscrowFinalizedProjection | null>;
}

export class EscrowEventProjectionError extends Error {
  readonly name = 'EscrowEventProjectionError';

  constructor(readonly code: 'market_unavailable' | 'position_unavailable' | 'account_owner_mismatch' | 'event_mismatch') {
    super(`escrow event projection rejected: ${code}`);
  }
}

export class SolanaEscrowEventProjector implements EscrowEventProjector {
  constructor(
    private readonly accounts: SolanaEscrowAccountReader,
    private readonly deployment: {
      readonly programId: string;
      readonly canonicalUsdcMint: string;
      readonly custodyVersion: number;
    },
  ) {}

  private async market(address: string): Promise<DecodedEscrowAccount<MarketAccount>> {
    const account = await this.accounts.market(address);
    if (account === null) throw new EscrowEventProjectionError('market_unavailable');
    if (account.ownerProgramId !== this.deployment.programId) {
      throw new EscrowEventProjectionError('account_owner_mismatch');
    }
    return account;
  }

  private async position(address: string): Promise<DecodedEscrowAccount<UserPositionAccount>> {
    const account = await this.accounts.position(address);
    if (account === null) throw new EscrowEventProjectionError('position_unavailable');
    if (account.ownerProgramId !== this.deployment.programId) {
      throw new EscrowEventProjectionError('account_owner_mismatch');
    }
    return account;
  }

  async project(event: EscrowProgramEvent): Promise<EscrowFinalizedProjection | null> {
    switch (event.kind) {
      case 'MarketInitialized': {
        const market = await this.market(event.market);
        if (
          market.value.marketUuid !== event.marketUuid ||
          bytesToHex(market.value.marketDocumentHash) !== bytesToHex(event.marketDocumentHash) ||
          market.value.asset !== event.asset || market.value.ratioMilli !== event.ratioMilli ||
          market.value.vault !== event.vault
        ) throw new EscrowEventProjectionError('event_mismatch');
        return {
          kind: 'market', marketId: event.marketUuid, custodyVersion: this.deployment.custodyVersion,
          marketPda: event.market, vaultPda: event.vault, asset: event.asset,
          mintPubkey: event.asset === 'usdc' ? market.value.tokenMint : null,
          documentHashHex: bytesToHex(event.marketDocumentHash), oracleEpoch: market.value.oracleSetEpoch,
          eventEpoch: 0n, ratioMilli: BigInt(event.ratioMilli),
        };
      }
      case 'PositionPlaced': {
        const market = await this.market(event.market);
        return {
          kind: 'position', marketId: market.value.marketUuid, positionPda: event.position,
          ownerPubkey: event.owner, lotNonce: event.nonce, eventKind: 'placed', side: event.side,
          asset: event.asset, amountAtomic: event.amount, eventEpoch: event.eventEpoch,
          state: event.pending ? 'pending' : 'active',
        };
      }
      case 'PositionActivated':
      case 'PositionInvalidated': {
        const [market, position] = await Promise.all([
          this.market(event.market),
          this.position(event.position),
        ]);
        if (position.value.market !== event.market || position.value.owner !== event.owner) {
          throw new EscrowEventProjectionError('event_mismatch');
        }
        const invalidated = event.kind === 'PositionInvalidated';
        return {
          kind: 'position', marketId: market.value.marketUuid, positionPda: event.position,
          ownerPubkey: event.owner, lotNonce: event.nonce,
          eventKind: invalidated ? 'invalidated' : 'activated', side: position.value.side,
          asset: market.value.asset, amountAtomic: event.amount, eventEpoch: event.eventEpoch,
          state: invalidated ? 'invalidated' : 'active',
        };
      }
      case 'MarketSettled':
      case 'MarketVoided': {
        const market = await this.market(event.market);
        const voided = event.kind === 'MarketVoided';
        const outcome = voided ? 'void' : event.outcome;
        if (outcome === null) throw new EscrowEventProjectionError('event_mismatch');
        return {
          kind: 'settlement', marketId: market.value.marketUuid, outcome,
          evidenceHashHex: bytesToHex(event.evidenceHash),
          documentHashHex: bytesToHex(market.value.marketDocumentHash),
          oracleEpoch: market.value.oracleSetEpoch,
        };
      }
      case 'PositionClaimed': {
        const [market, position] = await Promise.all([
          this.market(event.market),
          this.position(event.position),
        ]);
        const destination = event.asset === 'sol'
          ? event.owner
          : deriveUsdcVaultAddress(event.owner, this.deployment.canonicalUsdcMint).toBase58();
        return {
          kind: 'claim', marketId: market.value.marketUuid, ownerPubkey: event.owner,
          destinationPubkey: destination, asset: event.asset, amountAtomic: event.amount,
          claimKind: market.value.state === 'voided' || position.value.refundableAmount > 0n ? 'refund' : 'payout',
        };
      }
      case 'ProtocolConfigInitialized':
      case 'ProtocolConfigRotated':
      case 'OracleSetRotated':
      case 'ProtocolPauseChanged':
      case 'MarketFrozen':
      case 'MarketUnfrozen':
      case 'MarketClosed':
        return null;
    }
  }
}
