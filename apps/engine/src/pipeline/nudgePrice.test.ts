/**
 * guessNudgeProbability side-inference: the priced nudge must never quote the
 * OPPOSITE of what was claimed. Negations and two-team mentions decline to
 * price; under-lines flip the over probability.
 */

import { describe, expect, it } from 'vitest';
import { guessNudgeProbability } from './nudgePrice.js';
import type { Deps, FixtureRow, OddsFetchResult } from '../ports.js';

const NOW = Date.parse('2026-07-03T18:00:00.000Z');

const FIXTURE: FixtureRow = {
  fixture_id: 42,
  p1_name: 'Egypt',
  p2_name: 'Ghana',
  kickoff_at: new Date(NOW + 60 * 60_000).toISOString(),
  phase: 'NS',
  minute: null,
  last_seq: 0,
  score: {},
  coverage_unreliable: false,
};

const ODDS = {
  p1x2: { home: 0.4, draw: 0.28, away: 0.32 },
  totals: { line: 2.5, overProb: 0.6 },
  oddsMessageId: 'om-1',
  oddsTsMs: NOW,
};

function makeDeps(fetchOdds?: () => OddsFetchResult): Deps {
  return {
    db: { fixturesBetween: async () => [FIXTURE] },
    tx: {
      fetchOdds: async () => (fetchOdds ? fetchOdds() : ({ kind: 'ok', odds: ODDS } as const)),
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => NOW,
  } as unknown as Deps;
}

describe('guessNudgeProbability side inference', () => {
  it('prices the home side when only the home team is named', async () => {
    const price = await guessNudgeProbability(makeDeps(), 'Egypt will win this', 'match_winner');
    expect(price?.probability).toBe(0.4);
  });

  it('prices the away side when only the away team is named', async () => {
    const price = await guessNudgeProbability(makeDeps(), 'Ghana to win tonight', 'match_winner');
    expect(price?.probability).toBe(0.32);
  });

  it('declines to price when both teams are named (side is ambiguous)', async () => {
    const price = await guessNudgeProbability(
      makeDeps(),
      'Ghana will beat Egypt today',
      'match_winner',
    );
    expect(price).toBeNull();
  });

  it('declines to price negated claims instead of quoting the opposite outcome', async () => {
    expect(
      await guessNudgeProbability(makeDeps(), 'Ghana will lose to Egypt', 'match_winner'),
    ).toBeNull();
    // Smart-punctuation apostrophe, the iOS/Telegram default.
    expect(await guessNudgeProbability(makeDeps(), 'Ghana won’t win this', 'match_winner')).toBeNull();
    expect(await guessNudgeProbability(makeDeps(), "Egypt can't win here", 'match_winner')).toBeNull();
    expect(await guessNudgeProbability(makeDeps(), 'no way Egypt wins', 'match_winner')).toBeNull();
  });

  it('flips the over probability for under claims', async () => {
    const under = await guessNudgeProbability(
      makeDeps(),
      'under 2.5 goals in the Egypt game',
      'totals_ou',
    );
    expect(under?.probability).toBeCloseTo(0.4, 10);
    const over = await guessNudgeProbability(
      makeDeps(),
      'over 2.5 goals in the Egypt game',
      'totals_ou',
    );
    expect(over?.probability).toBe(0.6);
  });

  it('returns null on transient or empty odds fetches', async () => {
    expect(
      await guessNudgeProbability(
        makeDeps(() => ({ kind: 'transient' })),
        'Egypt will win',
        'match_winner',
      ),
    ).toBeNull();
    expect(
      await guessNudgeProbability(
        makeDeps(() => ({ kind: 'no_odds' })),
        'Egypt will win',
        'match_winner',
      ),
    ).toBeNull();
  });
});
