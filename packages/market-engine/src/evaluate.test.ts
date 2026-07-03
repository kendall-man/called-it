import { describe, expect, it } from 'vitest';
import { evaluateSpec, isPeriodComplete } from './evaluate.js';
import type { GamePhase } from './types.js';
import { mkScore, mkSpec, playerRef, teamRef } from './testkit.js';

describe('isPeriodComplete', () => {
  it('FT_90 completes as soon as regulation is over', () => {
    for (const phase of ['F', 'ET1', 'HTET', 'ET2', 'PE', 'FET', 'FPE'] as GamePhase[]) {
      expect(isPeriodComplete('FT_90', phase)).toBe(true);
    }
    for (const phase of ['NS', 'H1', 'HT', 'H2', 'INT'] as GamePhase[]) {
      expect(isPeriodComplete('FT_90', phase)).toBe(false);
    }
  });

  it('FT completes only at a terminal phase', () => {
    for (const phase of ['F', 'FET', 'FPE'] as GamePhase[]) {
      expect(isPeriodComplete('FT', phase)).toBe(true);
    }
    for (const phase of ['H2', 'ET1', 'ET2', 'PE'] as GamePhase[]) {
      expect(isPeriodComplete('FT', phase)).toBe(false);
    }
  });
});

describe('evaluateSpec — match_winner', () => {
  const winner90 = mkSpec({
    claimType: 'match_winner',
    entityRef: teamRef(1),
    comparator: 'gte',
    threshold: 1,
    period: 'FT_90',
  });
  const winnerFT = { ...winner90, period: 'FT' as const };

  it('is undecidable while the match runs', () => {
    expect(evaluateSpec(winner90, mkScore(2, 0), 'H2')).toBeNull();
    expect(evaluateSpec(winnerFT, mkScore(2, 0), 'H2')).toBeNull();
  });

  it('settles a 90-minute win at full time', () => {
    expect(evaluateSpec(winner90, mkScore(2, 1), 'F')).toBe('claim_won');
    expect(evaluateSpec(winner90, mkScore(1, 2), 'F')).toBe('claim_lost');
  });

  it('a draw in 90 loses the FT_90 win claim', () => {
    expect(evaluateSpec(winner90, mkScore(1, 1), 'F')).toBe('claim_lost');
  });

  it('FT_90 becomes decidable the moment extra time starts', () => {
    const score = mkScore(1, 1, { p1Goals90: 1, p2Goals90: 1 });
    expect(evaluateSpec(winner90, score, 'ET1')).toBe('claim_lost');
  });

  it('FT_90 in extra time requires the 90-minute split', () => {
    // Normalizer could not split regulation goals — never guess.
    expect(evaluateSpec(winner90, mkScore(2, 1), 'ET2')).toBeNull();
  });

  it('FT vs FT_90 diverge across extra time (1-1 after 90, 2-1 after ET)', () => {
    const afterEt = mkScore(2, 1, { p1Goals90: 1, p2Goals90: 1 });
    expect(evaluateSpec(winner90, afterEt, 'FET')).toBe('claim_lost');
    expect(evaluateSpec(winnerFT, afterEt, 'FET')).toBe('claim_won');
  });

  it('FT is undecidable during extra time even with a lead', () => {
    const score = mkScore(2, 1, { p1Goals90: 1, p2Goals90: 1 });
    expect(evaluateSpec(winnerFT, score, 'ET2')).toBeNull();
  });

  it('FT at FPE settles when the goal tallies differ', () => {
    const score = mkScore(3, 2, { p1Goals90: 1, p2Goals90: 1 });
    expect(evaluateSpec(winnerFT, score, 'FPE')).toBe('claim_won');
  });

  it('FT at FPE with level goals is not derivable (shootout is not goals)', () => {
    const score = mkScore(2, 2, { p1Goals90: 1, p2Goals90: 1 });
    expect(evaluateSpec(winnerFT, score, 'FPE')).toBeNull();
  });

  it('FT_90 at FPE settles from the 90-minute split', () => {
    const score = mkScore(2, 2, { p1Goals90: 1, p2Goals90: 0 });
    expect(evaluateSpec(mkSpec({ ...winner90 }), score, 'FPE')).toBe('claim_won');
  });

  it('returns void on abandonment phases', () => {
    expect(evaluateSpec(winner90, mkScore(2, 0), 'ABD')).toBe('void');
    expect(evaluateSpec(winnerFT, mkScore(2, 0), 'POST')).toBe('void');
  });
});

describe('evaluateSpec — comeback (winner semantics for the anchored side)', () => {
  const comeback = mkSpec({
    claimType: 'comeback',
    entityRef: teamRef(2),
    comparator: 'gte',
    threshold: 1,
    period: 'FT',
    anchor: { seq: 10, scoreP1: 1, scoreP2: 0 },
  });

  it('wins when the trailing side ends up winning the match', () => {
    expect(evaluateSpec(comeback, mkScore(1, 2), 'F')).toBe('claim_won');
  });

  it('loses on a draw — level is not a comeback', () => {
    expect(evaluateSpec(comeback, mkScore(1, 1), 'F')).toBe('claim_lost');
  });

  it('stays open until the period completes', () => {
    expect(evaluateSpec(comeback, mkScore(1, 2), 'H2')).toBeNull();
  });
});

describe('evaluateSpec — totals_ou', () => {
  const over25 = mkSpec({
    claimType: 'totals_ou',
    comparator: 'gte',
    threshold: 2.5,
    period: 'FT_90',
  });
  const under25 = { ...over25, comparator: 'lte' as const };

  it('over settles early the moment the third goal lands', () => {
    expect(evaluateSpec(over25, mkScore(2, 1), 'H2')).toBe('claim_won');
  });

  it('over stays open at 2 goals and loses at full time', () => {
    expect(evaluateSpec(over25, mkScore(1, 1), 'H2')).toBeNull();
    expect(evaluateSpec(over25, mkScore(1, 1), 'F')).toBe('claim_lost');
  });

  it('under loses early once the line is breached', () => {
    expect(evaluateSpec(under25, mkScore(2, 1), 'H1')).toBe('claim_lost');
  });

  it('under wins only when the period completes', () => {
    expect(evaluateSpec(under25, mkScore(1, 1), 'H2')).toBeNull();
    expect(evaluateSpec(under25, mkScore(1, 1), 'F')).toBe('claim_won');
  });

  it('eq settles only at period end unless already breached', () => {
    const exactly2 = mkSpec({
      claimType: 'totals_ou',
      comparator: 'eq',
      threshold: 2,
      period: 'FT_90',
    });
    expect(evaluateSpec(exactly2, mkScore(1, 1), 'H2')).toBeNull();
    expect(evaluateSpec(exactly2, mkScore(2, 1), 'H2')).toBe('claim_lost');
    expect(evaluateSpec(exactly2, mkScore(1, 1), 'F')).toBe('claim_won');
    expect(evaluateSpec(exactly2, mkScore(1, 0), 'F')).toBe('claim_lost');
  });

  it('FT_90 totals ignore extra-time goals via the 90-minute split', () => {
    const score = mkScore(3, 1, { p1Goals90: 1, p2Goals90: 1 });
    expect(evaluateSpec(over25, score, 'FET')).toBe('claim_lost');
    const ftOver = { ...over25, period: 'FT' as const };
    expect(evaluateSpec(ftOver, score, 'FET')).toBe('claim_won');
  });
});

describe('evaluateSpec — team_scores_n', () => {
  const franceTwo = mkSpec({
    claimType: 'team_scores_n',
    entityRef: teamRef(1),
    comparator: 'gte',
    threshold: 2,
    period: 'FT_90',
  });

  it('settles early once the tally is reached', () => {
    expect(evaluateSpec(franceTwo, mkScore(2, 0), 'H1')).toBe('claim_won');
  });

  it('only counts the named side', () => {
    expect(evaluateSpec(franceTwo, mkScore(0, 5), 'H2')).toBeNull();
    expect(evaluateSpec(franceTwo, mkScore(0, 5), 'F')).toBe('claim_lost');
  });

  it('own goals credited in the feed score count for team totals', () => {
    // The feed score already contains own goals — team_scores_n uses it as-is.
    expect(evaluateSpec(franceTwo, mkScore(2, 0), 'F')).toBe('claim_won');
  });

  it('is undecidable for an unbound player-entity spec', () => {
    const unbound = mkSpec({
      claimType: 'team_scores_n',
      entityRef: playerRef(null),
      threshold: 1,
    });
    expect(evaluateSpec(unbound, mkScore(3, 0), 'F')).toBeNull();
  });
});

describe('evaluateSpec — btts', () => {
  const btts = mkSpec({
    claimType: 'btts',
    comparator: 'gte',
    threshold: 1,
    period: 'FT_90',
  });

  it('wins early the moment both sides have scored', () => {
    expect(evaluateSpec(btts, mkScore(1, 1), 'H1')).toBe('claim_won');
  });

  it('stays open while one side is blank, loses at the whistle', () => {
    expect(evaluateSpec(btts, mkScore(3, 0), 'H2')).toBeNull();
    expect(evaluateSpec(btts, mkScore(3, 0), 'F')).toBe('claim_lost');
  });

  it('FT_90: a second-side goal in extra time does not rescue it', () => {
    const score = mkScore(1, 1, { p1Goals90: 1, p2Goals90: 0 });
    expect(evaluateSpec(btts, score, 'FET')).toBe('claim_lost');
    expect(evaluateSpec({ ...btts, period: 'FT' }, score, 'FET')).toBe('claim_won');
  });
});

describe('evaluateSpec — player_scores_n', () => {
  const brace = mkSpec({
    claimType: 'player_scores_n',
    entityRef: playerRef(1),
    comparator: 'gte',
    threshold: 2,
    period: 'FT_90',
    trustTier: 'oracle_resolved',
  });

  it('needs the reducer-fed tally — undecidable without it', () => {
    expect(evaluateSpec(brace, mkScore(5, 0), 'F')).toBeNull();
  });

  it('settles early once the tally reaches the threshold', () => {
    expect(evaluateSpec(brace, mkScore(2, 0), 'H2', 2)).toBe('claim_won');
  });

  it('loses at period end when short', () => {
    expect(evaluateSpec(brace, mkScore(2, 0), 'H2', 1)).toBeNull();
    expect(evaluateSpec(brace, mkScore(2, 0), 'F', 1)).toBe('claim_lost');
  });

  it('a zero tally is a real tally (own goals excluded upstream)', () => {
    expect(evaluateSpec(brace, mkScore(2, 0), 'F', 0)).toBe('claim_lost');
  });
});
