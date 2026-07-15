import type { GroupPointsService, GroupPointsSummary } from '../points/service.js';

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
