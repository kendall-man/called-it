import { describe, expect, it } from 'vitest';
import {
  lambdaFromTotalsLine,
  poissonCdf,
  poissonPmf,
  poissonSurvival,
  priceSpec,
} from './price.js';
import { TUNABLES } from './constants.js';
import { mkCtx, mkOdds, mkSpec, playerRef, teamRef } from './testkit.js';

/**
 * Hand-computed anchors (independent bisection over the Poisson survival
 * function, run outside this codebase):
 *   λ_total for line 2.5 @ over 0.6      ≈ 3.105379
 *   λ_1 with 1X2 {.5,.3,.2} (share .65)  ≈ 2.018496
 *   P(X₁ ≥ 2)                            ≈ 0.598977
 *   btts = (1-e^-λ1)(1-e^-λ2)            ≈ 0.574686
 *   P(player ≥ 1), λ = λ1·0.3            ≈ 0.454225
 *   P(total ≥ 4)                         ≈ 0.376363
 *   in-play team ≥2, 1 scored, 45' left  ≈ 0.635507
 *   FT away advance (.2 + .3·(.2/.7))    ≈ 0.285714
 */
const ANCHOR = {
  lambdaTotal: 3.105379,
  team1Gte2: 0.598977,
  btts: 0.574686,
  playerGte1: 0.454225,
  totalGte4: 0.376363,
  inplayTeamGte2: 0.635507,
  ftAwayAdvance: 0.285714,
};
const TOL = 1e-4;

describe('poisson helpers', () => {
  it('pmf matches closed-form values', () => {
    expect(poissonPmf(0, 2)).toBeCloseTo(Math.exp(-2), 10);
    expect(poissonPmf(2, 2)).toBeCloseTo(2 * Math.exp(-2), 10);
    expect(poissonPmf(-1, 2)).toBe(0);
  });

  it('cdf and survival are complementary', () => {
    for (const k of [0, 1, 3, 6]) {
      expect(poissonCdf(k, 2.7) + poissonSurvival(k + 1, 2.7)).toBeCloseTo(1, 10);
    }
    expect(poissonSurvival(0, 5)).toBe(1);
  });

  it('inverts a totals line to the implied goal rate', () => {
    const lambda = lambdaFromTotalsLine(2.5, 0.6);
    expect(lambda).toBeCloseTo(ANCHOR.lambdaTotal, 4);
    // Round-trips: P(X >= 3) at that rate is the quoted over probability.
    expect(poissonSurvival(3, lambda)).toBeCloseTo(0.6, 6);
  });
});

describe('priceSpec — match_winner provenance (FT vs FT_90 rule)', () => {
  it('FT_90 is a direct market read of the 1X2', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'match_winner', entityRef: teamRef(1), period: 'FT_90' }),
      mkOdds(),
      mkCtx(),
    );
    expect(quote.probability).toBeCloseTo(0.5, 10);
    expect(quote.multiplier).toBeCloseTo(2, 10);
    expect(quote.provenance).toBe('market');
  });

  it('FT (advancing) splits the draw mass — modelled', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'match_winner', entityRef: teamRef(2), period: 'FT' }),
      mkOdds(),
      mkCtx(),
    );
    expect(quote.probability).toBeCloseTo(ANCHOR.ftAwayAdvance, 4);
    expect(quote.provenance).toBe('modelled');
  });

  it('FT advance probabilities of both sides sum to 1', () => {
    const home = priceSpec(
      mkSpec({ claimType: 'match_winner', entityRef: teamRef(1), period: 'FT' }),
      mkOdds(),
      mkCtx(),
    );
    const away = priceSpec(
      mkSpec({ claimType: 'match_winner', entityRef: teamRef(2), period: 'FT' }),
      mkOdds(),
      mkCtx(),
    );
    expect(home.probability + away.probability).toBeCloseTo(1, 8);
  });

  it('throws a descriptive error without 1X2 input', () => {
    expect(() =>
      priceSpec(
        mkSpec({ claimType: 'match_winner', period: 'FT_90' }),
        mkOdds({ p1x2: null }),
        mkCtx(),
      ),
    ).toThrow(/1X2/);
  });

  it('comeback prices like the win market for the anchored side', () => {
    const quote = priceSpec(
      mkSpec({
        claimType: 'comeback',
        entityRef: teamRef(2),
        period: 'FT_90',
        anchor: { seq: 5, scoreP1: 1, scoreP2: 0 },
      }),
      mkOdds(),
      mkCtx(),
    );
    expect(quote.probability).toBeCloseTo(0.2, 10);
    expect(quote.provenance).toBe('market');
  });
});

describe('priceSpec — totals_ou', () => {
  it('reads the matching half-goal FT_90 line directly as market', () => {
    const over = priceSpec(
      mkSpec({ claimType: 'totals_ou', comparator: 'gte', threshold: 2.5, period: 'FT_90' }),
      mkOdds(),
      mkCtx(),
    );
    expect(over.probability).toBeCloseTo(0.6, 10);
    expect(over.provenance).toBe('market');

    const under = priceSpec(
      mkSpec({ claimType: 'totals_ou', comparator: 'lte', threshold: 2.5, period: 'FT_90' }),
      mkOdds(),
      mkCtx(),
    );
    expect(under.probability).toBeCloseTo(0.4, 10);
    expect(under.provenance).toBe('market');
  });

  it('derives non-matching lines through the Poisson model', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'totals_ou', comparator: 'gte', threshold: 3.5, period: 'FT_90' }),
      mkOdds(),
      mkCtx(),
    );
    expect(quote.probability).toBeCloseTo(ANCHOR.totalGte4, 4);
    expect(quote.provenance).toBe('modelled');
  });

  it('eq comparators are always modelled', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'totals_ou', comparator: 'eq', threshold: 2, period: 'FT_90' }),
      mkOdds(),
      mkCtx(),
    );
    expect(quote.provenance).toBe('modelled');
    expect(quote.probability).toBeGreaterThan(0);
    expect(quote.probability).toBeLessThan(1);
  });

  it('FT totals are modelled even on the matching line (extra-time inflation)', () => {
    const ft = priceSpec(
      mkSpec({ claimType: 'totals_ou', comparator: 'gte', threshold: 2.5, period: 'FT' }),
      mkOdds(),
      mkCtx(),
    );
    expect(ft.provenance).toBe('modelled');
    // More expected goals than the 90-minute market read.
    expect(ft.probability).toBeGreaterThan(0.6);
  });

  it('falls back to a default goal rate when no totals line is quoted', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'totals_ou', comparator: 'gte', threshold: 2.5, period: 'FT_90' }),
      mkOdds({ totals: null }),
      mkCtx(),
    );
    expect(quote.provenance).toBe('modelled');
    expect(quote.probability).toBeGreaterThan(0);
    expect(quote.probability).toBeLessThan(1);
  });
});

describe('priceSpec — independent-Poisson derived markets', () => {
  it('team_scores_n splits the total rate by the 1X2 lean', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'team_scores_n', entityRef: teamRef(1), threshold: 2 }),
      mkOdds(),
      mkCtx(),
    );
    expect(quote.probability).toBeCloseTo(ANCHOR.team1Gte2, 4);
    expect(quote.provenance).toBe('modelled');
  });

  it('the favourite gets the larger share of goals', () => {
    const fav = priceSpec(
      mkSpec({ claimType: 'team_scores_n', entityRef: teamRef(1), threshold: 2 }),
      mkOdds(),
      mkCtx(),
    );
    const dog = priceSpec(
      mkSpec({ claimType: 'team_scores_n', entityRef: teamRef(2), threshold: 2 }),
      mkOdds(),
      mkCtx(),
    );
    expect(fav.probability).toBeGreaterThan(dog.probability);
  });

  it('btts multiplies the two scoring probabilities', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'btts', comparator: 'gte', threshold: 1 }),
      mkOdds(),
      mkCtx(),
    );
    expect(quote.probability).toBeCloseTo(ANCHOR.btts, 4);
    expect(quote.provenance).toBe('modelled');
  });

  it('player_scores_n applies the striker share of the team rate', () => {
    const quote = priceSpec(
      mkSpec({
        claimType: 'player_scores_n',
        entityRef: playerRef(1),
        threshold: 1,
        trustTier: 'oracle_resolved',
      }),
      mkOdds(),
      mkCtx(),
    );
    expect(quote.probability).toBeCloseTo(ANCHOR.playerGte1, 4);
    expect(quote.provenance).toBe('modelled');
  });

  it('throws for a player not yet bound to a side', () => {
    expect(() =>
      priceSpec(
        mkSpec({
          claimType: 'player_scores_n',
          entityRef: playerRef(null),
          threshold: 1,
        }),
        mkOdds(),
        mkCtx(),
      ),
    ).toThrow(/side/);
  });

  it('splits 50/50 without a 1X2 lean', () => {
    const q1 = priceSpec(
      mkSpec({ claimType: 'team_scores_n', entityRef: teamRef(1), threshold: 1 }),
      mkOdds({ p1x2: null }),
      mkCtx(),
    );
    const q2 = priceSpec(
      mkSpec({ claimType: 'team_scores_n', entityRef: teamRef(2), threshold: 1 }),
      mkOdds({ p1x2: null }),
      mkCtx(),
    );
    expect(q1.probability).toBeCloseTo(q2.probability, 10);
  });
});

describe('priceSpec — in-play conditioning', () => {
  it('conditions team_scores_n on goals already scored and time left', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'team_scores_n', entityRef: teamRef(1), threshold: 2 }),
      mkOdds(),
      mkCtx({ fixture: { phase: 'H2', minute: 45, score: { p1Goals: 1, p2Goals: 0 } } }),
    );
    expect(quote.probability).toBeCloseTo(ANCHOR.inplayTeamGte2, 4);
  });

  it('an already-satisfied gte claim prices to certainty (min multiplier)', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'team_scores_n', entityRef: teamRef(1), threshold: 2 }),
      mkOdds(),
      mkCtx({ fixture: { phase: 'H2', minute: 60, score: { p1Goals: 2, p2Goals: 0 } } }),
    );
    expect(quote.probability).toBe(1);
    expect(quote.multiplier).toBe(TUNABLES.MULTIPLIER_MIN);
  });

  it('an already-dead lte claim prices to zero (max multiplier)', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'totals_ou', comparator: 'lte', threshold: 2.5, period: 'FT' }),
      mkOdds(),
      mkCtx({ fixture: { phase: 'H2', minute: 60, score: { p1Goals: 2, p2Goals: 1 } } }),
    );
    expect(quote.probability).toBe(0);
    expect(quote.multiplier).toBe(TUNABLES.MULTIPLIER_MAX);
  });

  it('a side that already scored contributes certainty to btts', () => {
    const oneNil = priceSpec(
      mkSpec({ claimType: 'btts', comparator: 'gte', threshold: 1 }),
      mkOdds(),
      mkCtx({ fixture: { phase: 'H1', minute: 30, score: { p1Goals: 1, p2Goals: 0 } } }),
    );
    const nilNil = priceSpec(
      mkSpec({ claimType: 'btts', comparator: 'gte', threshold: 1 }),
      mkOdds(),
      mkCtx({ fixture: { phase: 'H1', minute: 30, score: { p1Goals: 0, p2Goals: 0 } } }),
    );
    expect(oneNil.probability).toBeGreaterThan(nilNil.probability);
    expect(oneNil.probability).toBeLessThan(1);
  });

  it('FT_90 claims have no scoring time left in extra time', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'team_scores_n', entityRef: teamRef(1), threshold: 3, period: 'FT_90' }),
      mkOdds(),
      mkCtx({ fixture: { phase: 'ET1', minute: 95, score: { p1Goals: 2, p2Goals: 2 } } }),
    );
    expect(quote.probability).toBe(0);
  });
});

describe('priceSpec — clamps and odds pins', () => {
  it('clamps the multiplier into the tunable band', () => {
    const longShot = priceSpec(
      mkSpec({ claimType: 'match_winner', entityRef: teamRef(2), period: 'FT_90' }),
      mkOdds({ p1x2: { home: 0.98, draw: 0.015, away: 0.005 } }),
      mkCtx(),
    );
    expect(longShot.multiplier).toBe(TUNABLES.MULTIPLIER_MAX);
    const nearLock = priceSpec(
      mkSpec({ claimType: 'match_winner', entityRef: teamRef(1), period: 'FT_90' }),
      mkOdds({ p1x2: { home: 0.995, draw: 0.004, away: 0.001 } }),
      mkCtx(),
    );
    expect(nearLock.multiplier).toBe(TUNABLES.MULTIPLIER_MIN);
  });

  it('multipliers inside the band are exactly 1/p', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'match_winner', entityRef: teamRef(1), period: 'FT_90' }),
      mkOdds(),
      mkCtx(),
    );
    expect(quote.multiplier).toBeCloseTo(1 / quote.probability, 10);
  });

  it('carries the odds provenance pins on every quote', () => {
    const quotes = [
      priceSpec(mkSpec({ claimType: 'match_winner', period: 'FT_90' }), mkOdds(), mkCtx()),
      priceSpec(mkSpec({ claimType: 'totals_ou', threshold: 2.5, period: 'FT_90' }), mkOdds(), mkCtx()),
      priceSpec(mkSpec({ claimType: 'btts', threshold: 1 }), mkOdds(), mkCtx()),
    ];
    for (const quote of quotes) {
      expect(quote.oddsMessageId).toBe('msg-123');
      expect(quote.oddsTsMs).toBeTypeOf('number');
    }
  });

  it('propagates null pins honestly', () => {
    const quote = priceSpec(
      mkSpec({ claimType: 'btts', threshold: 1 }),
      mkOdds({ oddsMessageId: null, oddsTsMs: null }),
      mkCtx(),
    );
    expect(quote.oddsMessageId).toBeNull();
    expect(quote.oddsTsMs).toBeNull();
  });
});
