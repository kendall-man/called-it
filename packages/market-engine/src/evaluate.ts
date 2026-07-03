/**
 * Pure settlement predicate: given a spec and the current score/phase, decide
 * whether the claim is already won, lost, void, or not yet decidable (null).
 *
 * Period semantics:
 * - FT_90 claims are decided by regulation-time goals. Once the match enters
 *   extra time the 90-minute result is final, so FT_90 claims become decidable
 *   at ET1 — but only via `p1Goals90`/`p2Goals90`; if the normalizer could not
 *   split those out, the predicate stays undecided (the reducer voids at a
 *   terminal phase rather than guessing).
 * - FT claims (including ET/pens where the fixture goes there) are decided only
 *   at a terminal phase. At FPE a level goal count means the advancing side is
 *   not derivable from ScoreState (shootout results are not team goals), so the
 *   predicate stays null and the reducer voids honestly.
 */
import {
  TERMINAL_PHASES,
  VOID_PHASES,
  type Comparator,
  type GamePhase,
  type MarketSpec,
  type Period,
  type ScoreState,
  type SettlementOutcome,
} from './types.js';

/** Phases in which the 90-minute regulation period has fully elapsed. */
const REGULATION_COMPLETE_PHASES: readonly GamePhase[] = [
  'F',
  'ET1',
  'HTET',
  'ET2',
  'PE',
  'FET',
  'FPE',
];

/** Phases beyond regulation where only the 90'-split tallies may be used for FT_90. */
const BEYOND_REGULATION_PHASES: readonly GamePhase[] = [
  'ET1',
  'HTET',
  'ET2',
  'PE',
  'FET',
  'FPE',
];

export function isPeriodComplete(period: Period, phase: GamePhase): boolean {
  return period === 'FT_90'
    ? REGULATION_COMPLETE_PHASES.includes(phase)
    : TERMINAL_PHASES.includes(phase);
}

/**
 * Goals credited to a participant under the spec's period semantics.
 * Returns null when the required tally cannot be derived (e.g. FT_90 in extra
 * time without a 90-minute split from the feed).
 */
function goalsForPeriod(
  score: ScoreState,
  participant: 1 | 2,
  period: Period,
  phase: GamePhase,
): number | null {
  const team = participant === 1 ? score.p1 : score.p2;
  if (period === 'FT') return team.goals;
  // FT_90 below.
  const goals90 = participant === 1 ? score.p1Goals90 : score.p2Goals90;
  if (phase === 'F') {
    // Match ended at 90 — full goals ARE the 90-minute goals.
    return goals90 ?? team.goals;
  }
  if (BEYOND_REGULATION_PHASES.includes(phase)) {
    // Extra time / pens: only an explicit 90' split is trustworthy.
    return goals90;
  }
  // Regulation still running — the live tally is the 90-minute tally so far.
  return team.goals;
}

function participantOf(spec: MarketSpec): 1 | 2 | null {
  return spec.entityRef.kind === 'team'
    ? spec.entityRef.participant
    : spec.entityRef.participant;
}

/**
 * Comparator settlement for a monotonically non-decreasing tally (goals only
 * ever go up; reversals are handled upstream by the reducer re-evaluating).
 */
function compareTally(
  value: number,
  comparator: Comparator,
  threshold: number,
  periodComplete: boolean,
): SettlementOutcome | null {
  switch (comparator) {
    case 'gte':
      if (value >= threshold) return 'claim_won';
      return periodComplete ? 'claim_lost' : null;
    case 'lte':
      if (value > threshold) return 'claim_lost';
      return periodComplete ? 'claim_won' : null;
    case 'eq':
      if (value > threshold) return 'claim_lost';
      if (!periodComplete) return null;
      return value === threshold ? 'claim_won' : 'claim_lost';
  }
}

function winnerOutcome(
  spec: MarketSpec,
  score: ScoreState,
  phase: GamePhase,
): SettlementOutcome | null {
  if (!isPeriodComplete(spec.period, phase)) return null;
  const mine = participantOf(spec);
  if (mine === null) return null;
  const theirs: 1 | 2 = mine === 1 ? 2 : 1;
  const gMine = goalsForPeriod(score, mine, spec.period, phase);
  const gTheirs = goalsForPeriod(score, theirs, spec.period, phase);
  if (gMine === null || gTheirs === null) return null;
  if (gMine > gTheirs) return 'claim_won';
  if (gMine < gTheirs) return 'claim_lost';
  // Level.
  if (spec.period === 'FT_90') return 'claim_lost'; // draw in 90 — the call was a win
  if (phase === 'F') return 'claim_lost'; // match over at 90 with a draw
  // FET/FPE level: the advancing side is not derivable from team goal tallies.
  return null;
}

/**
 * Pure predicate used by reduceMarket. `playerGoals` is the reducer-maintained
 * per-period tally for player_scores_n specs (ScoreState carries no per-player
 * data); own goals must already be excluded by the caller.
 */
export function evaluateSpec(
  spec: MarketSpec,
  score: ScoreState,
  phase: GamePhase,
  playerGoals?: number,
): SettlementOutcome | null {
  if (VOID_PHASES.includes(phase)) return 'void';
  const complete = isPeriodComplete(spec.period, phase);

  switch (spec.claimType) {
    case 'match_winner':
    case 'comeback':
      return winnerOutcome(spec, score, phase);

    case 'totals_ou': {
      const g1 = goalsForPeriod(score, 1, spec.period, phase);
      const g2 = goalsForPeriod(score, 2, spec.period, phase);
      if (g1 === null || g2 === null) return null;
      return compareTally(g1 + g2, spec.comparator, spec.threshold, complete);
    }

    case 'team_scores_n': {
      const participant = participantOf(spec);
      if (participant === null) return null;
      const g = goalsForPeriod(score, participant, spec.period, phase);
      if (g === null) return null;
      return compareTally(g, spec.comparator, spec.threshold, complete);
    }

    case 'btts': {
      const g1 = goalsForPeriod(score, 1, spec.period, phase);
      const g2 = goalsForPeriod(score, 2, spec.period, phase);
      if (g1 !== null && g2 !== null && g1 >= 1 && g2 >= 1) return 'claim_won';
      if (!complete) return null;
      if (g1 === null || g2 === null) return null;
      return 'claim_lost';
    }

    case 'player_scores_n': {
      if (playerGoals === undefined) return null;
      return compareTally(playerGoals, spec.comparator, spec.threshold, complete);
    }
  }
}
