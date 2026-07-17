/**
 * voidAbandonedMarket is the call-off path for decline, the kickoff sweep and
 * the admin /settle clear-decks mode. The money contract: a 'void' settlement
 * row is recorded and the wager module's applySettlement (the single
 * money-movement path) is invoked so every escrowed stake refunds in full.
 */

import { describe, expect, it } from 'vitest';
import type { Deps, MarketRow } from '../ports.js';
import { hasNoActivePositions, voidAbandonedMarket } from './void.js';

function makeHarness(): {
  deps: Deps;
  statusWrites: Array<{ id: string; status: string }>;
  settlements: Array<Record<string, unknown>>;
  refundedMarkets: string[];
} {
  const statusWrites: Array<{ id: string; status: string }> = [];
  const settlements: Array<Record<string, unknown>> = [];
  const refundedMarkets: string[] = [];
  const deps = {
    db: {
      updateMarketStatus: async (id: string, status: string) => {
        statusWrites.push({ id, status });
      },
      insertSettlement: async (input: Record<string, unknown>) => {
        settlements.push(input);
      },
    },
    wager: {
      applySettlement: async (marketId: string) => {
        refundedMarkets.push(marketId);
      },
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  } as unknown as Deps;
  return { deps, statusWrites, settlements, refundedMarkets };
}

function market(currency: 'sol' | 'rep'): MarketRow {
  return {
    id: 'm-void',
    group_id: -300,
    currency,
    spec: { trustTier: 'oracle_resolved' },
  } as unknown as MarketRow;
}

describe('voidAbandonedMarket', () => {
  it('voids the market, records the void settlement and refunds through applySettlement', async () => {
    const { deps, statusWrites, settlements, refundedMarkets } = makeHarness();
    await voidAbandonedMarket(deps, market('sol'));
    expect(statusWrites).toEqual([{ id: 'm-void', status: 'voided' }]);
    expect(settlements).toEqual([
      {
        market_id: 'm-void',
        outcome: 'void',
        deciding_seq: null,
        evidence_seqs: [],
        tier: 'oracle_resolved',
      },
    ]);
    expect(refundedMarkets).toEqual(['m-void']);
  });

  it('leaves posted_at to the receipt cron (no posted_at in the settlement row)', async () => {
    const { deps, settlements } = makeHarness();
    await voidAbandonedMarket(deps, market('sol'));
    expect(settlements[0]).not.toHaveProperty('posted_at');
  });
});

describe('hasNoActivePositions', () => {
  it('is true only when every position is void', () => {
    expect(hasNoActivePositions([])).toBe(true);
    expect(hasNoActivePositions([{ state: 'void' }])).toBe(true);
    expect(hasNoActivePositions([{ state: 'void' }, { state: 'active' }])).toBe(false);
    expect(hasNoActivePositions([{ state: 'pending' }])).toBe(false);
  });
});
