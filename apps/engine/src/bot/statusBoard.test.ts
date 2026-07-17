/**
 * Board rendering tests: the open-calls board names every bettor per side
 * (the whole point of a group board), keeps empty sides honest, and the
 * attribution footer credits whoever pulled it up.
 */

import { describe, expect, it } from 'vitest';
import type { Deps, GroupRow, MarketRow, PositionRow } from '../ports.js';
import { boardAttribution, buildOpenCallsBoard } from './statusBoard.js';

const GROUP = { id: -300, slug: 'legends' } as unknown as GroupRow;

const USER_NAMES: Record<number, string> = {
  1: 'Dee',
  2: 'Sam',
  3: 'Marco',
  4: 'Kai',
  5: 'Ana',
  6: 'Ben',
};

interface PositionSeed {
  userId: number;
  side: 'back' | 'doubt';
  stake: number;
  state?: PositionRow['state'];
}

function makeDeps(positions: PositionSeed[]): Deps {
  const market = {
    id: 'm1',
    claim_id: 'c1',
    group_id: GROUP.id,
    fixture_id: 9001,
    status: 'open',
    quote_probability: 0.62,
  } as unknown as MarketRow;
  return {
    db: {
      openMarketsForGroup: async () => [market],
      getClaim: async () => ({ quoted_text: 'Spain win this', claimer_user_id: 1 }),
      getUser: async (id: number) => ({ id, display_name: USER_NAMES[id] ?? 'someone' }),
      positionsForMarket: async () =>
        positions.map(
          (seed, index) =>
            ({
              id: `p${index}`,
              market_id: 'm1',
              user_id: seed.userId,
              side: seed.side,
              stake: seed.stake,
              state: seed.state ?? 'active',
            }) as unknown as PositionRow,
        ),
    },
  } as unknown as Deps;
}

describe('buildOpenCallsBoard', () => {
  it('names the bettors on each side, biggest stake first', async () => {
    const board = await buildOpenCallsBoard(
      makeDeps([
        { userId: 2, side: 'back', stake: 10_000_000 },
        { userId: 1, side: 'back', stake: 50_000_000 },
        { userId: 3, side: 'doubt', stake: 30_000_000 },
      ]),
      GROUP,
    );
    expect(board).toContain('⚡ 0.06 SOL backing: Dee, Sam');
    expect(board).toContain('🛑 0.03 SOL against: Marco');
    expect(board).toContain('“Spain win this”, called by Dee');
  });

  it('keeps empty sides honest instead of showing zero-SOL noise', async () => {
    const board = await buildOpenCallsBoard(makeDeps([]), GROUP);
    expect(board).toContain('⚡ no backers yet');
    expect(board).toContain('🛑 nobody against yet');
  });

  it('collapses a crowded side into "+N more" past the naming cap', async () => {
    const backers: PositionSeed[] = [1, 2, 3, 4, 5, 6].map((userId) => ({
      userId,
      side: 'back',
      stake: (7 - userId) * 10_000_000,
    }));
    const board = await buildOpenCallsBoard(makeDeps(backers), GROUP);
    expect(board).toContain('backing: Dee, Sam, Marco, Kai +2 more');
    expect(board).not.toContain('Ana');
  });

  it('ignores voided positions entirely', async () => {
    const board = await buildOpenCallsBoard(
      makeDeps([
        { userId: 1, side: 'back', stake: 50_000_000 },
        { userId: 3, side: 'back', stake: 90_000_000, state: 'void' },
      ]),
      GROUP,
    );
    expect(board).toContain('⚡ 0.05 SOL backing: Dee');
    expect(board).not.toContain('Marco');
  });

  it('merges repeat stakes from the same member into one named entry', async () => {
    const board = await buildOpenCallsBoard(
      makeDeps([
        { userId: 1, side: 'back', stake: 10_000_000 },
        { userId: 1, side: 'back', stake: 40_000_000 },
      ]),
      GROUP,
    );
    expect(board).toContain('⚡ 0.05 SOL backing: Dee');
    expect(board).not.toContain('Dee, Dee');
  });
});

describe('boardAttribution', () => {
  it('credits the member who pulled the board up', () => {
    expect(boardAttribution('Λyush')).toBe('Pulled up by Λyush.');
  });

  it('stays inside the copy rules: no em dashes on the board', async () => {
    const board = await buildOpenCallsBoard(
      makeDeps([{ userId: 1, side: 'back', stake: 50_000_000 }]),
      GROUP,
    );
    expect(`${board}\n${boardAttribution('Dee')}`).not.toContain('—');
  });
});
