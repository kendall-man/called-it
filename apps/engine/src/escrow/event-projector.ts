import {
  bytesToHex,
  type EscrowProgramEvent,
  type MarketAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import type { EscrowFinalizedProjection } from './finalized-indexer.js';
import type {
  DecodedEscrowAccount,
  SolanaEscrowAccountReader,
} from './solana-accounts.js';
import type { EscrowPlacementMarketLinkResult } from './placement-types.js';

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

type EscrowEventAccountReader = Pick<SolanaEscrowAccountReader, 'market' | 'position'>;

export class EscrowEventProjectionError extends Error {
  readonly name = 'EscrowEventProjectionError';

  constructor(readonly code: 'market_unavailable' | 'position_unavailable' | 'account_owner_mismatch' | 'event_mismatch' | 'history_unavailable') {
    super(`escrow event projection rejected: ${code}`);
  }
}

export class SolanaEscrowEventProjector implements EscrowEventProjector {
  private readonly positionSides = new Map<string, UserPositionAccount['side']>();

  constructor(
    private readonly accounts: EscrowEventAccountReader,
    private readonly history: {
      getMarketLink(input: {
        readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
        readonly genesisHash: string;
        readonly programId: string;
        readonly marketPda: string;
      }): Promise<EscrowPlacementMarketLinkResult>;
    },
    private readonly deployment: {
      readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
      readonly genesisHash: string;
      readonly programId: string;
      readonly canonicalUsdcMint: string;
      readonly custodyVersion: number;
    },
  ) {}

  private async historicalMarket(address: string) {
    const link = await this.history.getMarketLink({
      cluster: this.deployment.cluster, genesisHash: this.deployment.genesisHash,
      programId: this.deployment.programId, marketPda: address,
    });
    if (
      !link.ok || !link.found || link.marketPda !== address ||
      link.cluster !== this.deployment.cluster || link.genesisHash !== this.deployment.genesisHash ||
      link.programId !== this.deployment.programId || link.commitment !== 'finalized' || link.projectionStale
    ) throw new EscrowEventProjectionError('history_unavailable');
    return link;
  }

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

  async project(
    event: EscrowProgramEvent,
    _context: EscrowEventProjectionContext,
  ): Promise<EscrowFinalizedProjection | null> {
    switch (event.kind) {
      case 'MarketInitialized': {
        const historical = await this.history.getMarketLink({
          cluster: this.deployment.cluster, genesisHash: this.deployment.genesisHash,
          programId: this.deployment.programId, marketPda: event.market,
        });
        if (historical.ok && historical.found) {
          if (
            historical.marketId !== event.marketUuid || historical.marketPda !== event.market ||
            historical.asset !== event.asset || historical.vaultPda !== event.vault ||
            historical.ratioMilli !== BigInt(event.ratioMilli) ||
            historical.documentHashHex !== bytesToHex(event.marketDocumentHash) ||
            historical.commitment !== 'finalized' || historical.projectionStale
          ) throw new EscrowEventProjectionError('event_mismatch');
          return {
            kind: 'market', marketId: historical.marketId,
            custodyVersion: historical.custodyVersion, marketPda: historical.marketPda,
            vaultPda: historical.vaultPda, asset: historical.asset,
            mintPubkey: historical.mintPubkey, documentHashHex: historical.documentHashHex,
            oracleEpoch: historical.oracleEpoch, eventEpoch: historical.eventEpoch,
            ratioMilli: historical.ratioMilli,
          };
        }
        if (!historical.ok) throw new EscrowEventProjectionError('history_unavailable');
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
        const market = await this.historicalMarket(event.market);
        this.positionSides.set(event.position, event.side);
        return {
          kind: 'position', marketId: market.marketId, positionPda: event.position,
          ownerPubkey: event.owner, lotNonce: event.nonce, eventKind: 'placed', side: event.side,
          asset: event.asset, amountAtomic: event.amount, eventEpoch: event.eventEpoch,
          state: event.pending ? 'pending' : 'active',
        };
      }
      case 'PositionActivated':
      case 'PositionInvalidated': {
        const market = await this.historicalMarket(event.market);
        const cachedSide = this.positionSides.get(event.position);
        const position = cachedSide === undefined ? await this.position(event.position) : null;
        const side = cachedSide ?? position?.value.side;
        if (side === undefined) throw new EscrowEventProjectionError('position_unavailable');
        if (position !== null && (position.value.market !== event.market || position.value.owner !== event.owner)) {
          throw new EscrowEventProjectionError('event_mismatch');
        }
        const invalidated = event.kind === 'PositionInvalidated';
        return {
          kind: 'position', marketId: market.marketId, positionPda: event.position,
          ownerPubkey: event.owner, lotNonce: event.nonce,
          eventKind: invalidated ? 'invalidated' : 'activated', side,
          asset: market.asset, amountAtomic: event.amount, eventEpoch: event.eventEpoch,
          state: invalidated ? 'invalidated' : 'active',
        };
      }
      case 'MarketSettled':
      case 'MarketVoided': {
        const market = await this.historicalMarket(event.market);
        const voided = event.kind === 'MarketVoided';
        const outcome = voided ? 'void' : event.outcome;
        if (outcome === null) throw new EscrowEventProjectionError('event_mismatch');
        return {
          kind: 'settlement', marketId: market.marketId, outcome,
          evidenceHashHex: bytesToHex(event.evidenceHash),
          documentHashHex: market.documentHashHex,
          oracleEpoch: market.oracleEpoch,
        };
      }
      case 'PositionClaimed': {
        const market = await this.historicalMarket(event.market);
        if (market.asset !== event.asset || (market.chainState !== 'settled' && market.chainState !== 'voided')) {
          throw new EscrowEventProjectionError('event_mismatch');
        }
        return {
          kind: 'claim', marketId: market.marketId, ownerPubkey: event.owner,
          destinationPubkey: event.destination, asset: event.asset, amountAtomic: event.amount,
          claimKind: market.chainState === 'voided' ? 'refund' : 'payout',
        };
      }
      case 'MarketClosed': {
        const market = await this.historicalMarket(event.market);
        if (market.asset !== event.asset) throw new EscrowEventProjectionError('event_mismatch');
        return {
          kind: 'market_closed', marketId: market.marketId, marketPda: event.market,
          documentHashHex: market.documentHashHex,
          asset: event.asset, dustAmountAtomic: event.dustAmount,
        };
      }
      case 'MarketFrozen':
      case 'MarketUnfrozen': {
        const market = await this.historicalMarket(event.market);
        if (event.eventEpoch <= market.eventEpoch) throw new EscrowEventProjectionError('event_mismatch');
        return {
          kind: 'market_state',
          marketId: market.marketId,
          state: event.kind === 'MarketFrozen' ? 'frozen' : 'open',
          eventEpoch: event.eventEpoch,
          evidenceHashHex: bytesToHex(event.evidenceHash),
        };
      }
      case 'ProtocolConfigInitialized':
      case 'ProtocolConfigRotated':
      case 'OracleSetRotated':
      case 'ProtocolPauseChanged':
      case 'MarketSettlementStarted':
      case 'PositionEntitlementCalculated':
      case 'PositionLotsClosed':
      case 'PositionClosed':
        return null;
    }
  }
}
