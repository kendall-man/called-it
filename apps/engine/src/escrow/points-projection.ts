import type { GroupPointsService, GroupPointsSummary } from '../points/service.js';
import type { MarketRow } from '../ports.js';

export interface EscrowPrivatePointsParticipants {
  prepare(marketId: string): Promise<{
    readonly custodyMode: 'escrow';
    readonly replay: boolean;
  }>;
}

export interface EscrowFinalizedPointsProjection {
  afterEconomicProjection(input: {
    readonly marketId: string;
    readonly kind: 'settlement' | 'claim';
    readonly signature: string;
    readonly instructionIndex: number;
  }): Promise<{ readonly kind: 'replay_skipped' } | { readonly kind: 'applied'; readonly summary: GroupPointsSummary }>;
}

export function createEscrowPrivatePointsParticipants(options: {
  readonly markets: {
    getMarket(marketId: string): Promise<Pick<MarketRow, 'custody_mode' | 'is_replay'> | null>;
  };
}): EscrowPrivatePointsParticipants {
  return {
    async prepare(marketId) {
      const market = await options.markets.getMarket(marketId);
      if (market === null) throw new Error('escrow points market unavailable');
      if (market.custody_mode !== 'escrow') throw new Error('escrow points market custody mismatch');
      return { custodyMode: 'escrow', replay: market.is_replay };
    },
  };
}

export function createEscrowFinalizedPointsProjection(options: {
  readonly privateParticipants: EscrowPrivatePointsParticipants;
  readonly points: GroupPointsService;
}): EscrowFinalizedPointsProjection {
  return {
    async afterEconomicProjection(input) {
      const prepared = await options.privateParticipants.prepare(input.marketId);
      if (prepared.custodyMode !== 'escrow') throw new TypeError('escrow points custody mismatch');
      if (prepared.replay) return { kind: 'replay_skipped' };
      return { kind: 'applied', summary: await options.points.apply(input.marketId) };
    },
  };
}
