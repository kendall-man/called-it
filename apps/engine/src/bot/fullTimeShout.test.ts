import { describe, expect, it } from 'vitest';
import type { SettlementOutcome } from '@calledit/market-engine';
import type { ClaimRow, FixtureRow, MarketRow, SettlementRow, UserRow } from '../ports.js';
import {
  buildFullTimeShout,
  type FullTimeShoutDb,
  type FullTimeShoutWager,
} from './fullTimeShout.js';

const GROUP = -300;
const FIXTURE = 9001;
const START_MS = Date.parse('2026-07-14T19:00:00Z');

const FIXTURE_ROW = {
  fixture_id: FIXTURE,
  p1_name: 'France',
  p2_name: 'Spain',
  phase: 'F',
  minute: null,
  score: { p1: { goals: 0 }, p2: { goals: 2 } },
} as unknown as FixtureRow;

interface SettledSeed {
  marketId: string;
  outcome: SettlementOutcome;
  quoted: string;
  claimer: string;
  moneyLine: string;
  groupId?: number;
  fixtureId?: number;
}

/** In-memory FullTimeShoutDb + wager over a list of settled-market seeds. */
function makeFakes(seeds: SettledSeed[]): {
  db: FullTimeShoutDb;
  wager: FullTimeShoutWager;
  sinceIsoSeen: string[];
} {
  const sinceIsoSeen: string[] = [];
  const byMarket = new Map(seeds.map((seed) => [seed.marketId, seed]));
  const db: FullTimeShoutDb = {
    async getFixture(fixtureId) {
      return fixtureId === FIXTURE ? FIXTURE_ROW : null;
    },
    async settlementsSince(sinceIso) {
      sinceIsoSeen.push(sinceIso);
      return seeds.map(
        (seed) =>
          ({
            market_id: seed.marketId,
            outcome: seed.outcome,
            settled_at: new Date(START_MS + 60_000).toISOString(),
          }) as unknown as SettlementRow,
      );
    },
    async getMarket(marketId) {
      const seed = byMarket.get(marketId);
      if (!seed) return null;
      return {
        id: seed.marketId,
        claim_id: `claim-${seed.marketId}`,
        group_id: seed.groupId ?? GROUP,
        fixture_id: seed.fixtureId ?? FIXTURE,
      } as unknown as MarketRow;
    },
    async getClaim(claimId) {
      const seed = [...byMarket.values()].find((s) => `claim-${s.marketId}` === claimId);
      if (!seed) return null;
      return {
        id: claimId,
        claimer_user_id: 1,
        quoted_text: seed.quoted,
      } as unknown as ClaimRow;
    },
    async getUser(id) {
      const seed = [...byMarket.values()][0];
      return { id, display_name: seed?.claimer ?? 'someone', username: null } as UserRow;
    },
  };
  const wager: FullTimeShoutWager = {
    async settlementPayoutsLine(marketId) {
      return byMarket.get(marketId)?.moneyLine ?? 'No SOL changed hands.';
    },
  };
  return { db, wager, sinceIsoSeen };
}

function shout(seeds: SettledSeed[]): Promise<string | null> {
  const { db, wager } = makeFakes(seeds);
  return buildFullTimeShout(db, wager, {
    groupId: GROUP,
    fixtureId: FIXTURE,
    matchStartedAtMs: START_MS,
  });
}

describe('buildFullTimeShout', () => {
  it('praises the winner with the exact payout and the final scoreline', async () => {
    const text = await shout([
      {
        marketId: 'm1',
        outcome: 'claim_won',
        quoted: 'Oyarzabal scores today',
        claimer: 'Dee',
        moneyLine: 'Dee collects 0.08 SOL.',
      },
    ]);
    expect(text).toContain('🏆 FULL TIME: France 0-2 Spain!');
    expect(text).toContain('Dee CALLED IT: “Oyarzabal scores today”');
    expect(text).toContain('Dee collects 0.08 SOL.');
    expect(text).toContain('Take a bow.');
  });

  it('consoles a fallen call and pays the doubters their flowers', async () => {
    const text = await shout([
      {
        marketId: 'm2',
        outcome: 'claim_lost',
        quoted: 'Mbappé scores twice',
        claimer: 'Sam',
        moneyLine: 'Marco collects 0.06 SOL.',
      },
    ]);
    expect(text).toContain('“Mbappé scores twice” never landed');
    expect(text).toContain('Marco collects 0.06 SOL.');
    expect(text).toContain('Chin up, Sam');
  });

  it('leads with the winners regardless of settlement order', async () => {
    const text = await shout([
      { marketId: 'a', outcome: 'claim_lost', quoted: 'L', claimer: 'X', moneyLine: 'l.' },
      { marketId: 'b', outcome: 'claim_won', quoted: 'W', claimer: 'X', moneyLine: 'w.' },
    ]);
    expect(text).not.toBeNull();
    expect(text!.indexOf('CALLED IT')).toBeLessThan(text!.indexOf('never landed'));
  });

  it('renders voids as call-offs without praise or blame', async () => {
    const text = await shout([
      {
        marketId: 'm3',
        outcome: 'void',
        quoted: 'France comeback',
        claimer: 'Kai',
        moneyLine: 'Call off. Every SOL stake returned.',
      },
    ]);
    expect(text).toContain('↩️ “France comeback”: Call off. Every SOL stake returned.');
  });

  it('ignores settlements from other groups and other fixtures', async () => {
    const text = await shout([
      { marketId: 'mine', outcome: 'claim_won', quoted: 'Mine', claimer: 'D', moneyLine: 'd.' },
      {
        marketId: 'other-group',
        outcome: 'claim_won',
        quoted: 'Not mine',
        claimer: 'D',
        moneyLine: 'x.',
        groupId: -999,
      },
      {
        marketId: 'other-fixture',
        outcome: 'claim_won',
        quoted: 'Not this match',
        claimer: 'D',
        moneyLine: 'x.',
        fixtureId: 8000,
      },
    ]);
    expect(text).toContain('Mine');
    expect(text).not.toContain('Not mine');
    expect(text).not.toContain('Not this match');
  });

  it('returns null when nothing settled, so the caller can post the plain line', async () => {
    expect(await shout([])).toBeNull();
  });

  it('summarizes past the entry cap instead of flooding the chat', async () => {
    const seeds: SettledSeed[] = Array.from({ length: 8 }, (_, i) => ({
      marketId: `m${i}`,
      outcome: 'claim_won' as const,
      quoted: `call ${i}`,
      claimer: 'D',
      moneyLine: 'x.',
    }));
    const text = await shout(seeds);
    expect(text).toContain('…and 2 more settled on the night.');
  });

  it('queries with a lookback margin so clock skew cannot drop early settlements', async () => {
    const { db, wager, sinceIsoSeen } = makeFakes([]);
    await buildFullTimeShout(db, wager, {
      groupId: GROUP,
      fixtureId: FIXTURE,
      matchStartedAtMs: START_MS,
    });
    expect(sinceIsoSeen).toHaveLength(1);
    expect(Date.parse(sinceIsoSeen[0]!)).toBeLessThan(START_MS);
  });

  it('reads as a live match: no em dashes, no replay talk, no links', async () => {
    const text = await shout([
      { marketId: 'm1', outcome: 'claim_won', quoted: 'W', claimer: 'D', moneyLine: 'D collects 0.1 SOL.' },
      { marketId: 'm2', outcome: 'claim_lost', quoted: 'L', claimer: 'D', moneyLine: 'No SOL changed hands.' },
    ]);
    expect(text).not.toContain('—');
    expect(text).not.toMatch(/[Rr]eplay/);
    expect(text).not.toMatch(/https?:\/\//);
  });
});
