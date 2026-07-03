/**
 * Pricing: turn demargined odds inputs into a probability + Rep multiplier.
 *
 * Provenance rules (truth-preserving per period semantics):
 * - match_winner / comeback FT_90 → direct 1X2 probability, "market"
 *   (StablePrice 1X2 is a 90-minute market).
 * - match_winner / comeback FT (incl. ET/pens) → "modelled": the draw mass is
 *   split between advance outcomes proportionally to the two win probabilities.
 * - totals_ou FT_90 on the exact half-goal feed line → direct over/under
 *   probability, "market". Any other line, comparator eq, or FT period →
 *   independent-Poisson, "modelled".
 * - team_scores_n / btts / player_scores_n → independent-Poisson derived from
 *   the totals line split by the 1X2 lean, always "modelled".
 *
 * Multipliers are clamp(1/p) per TUNABLES and rendered upstream as "×N Rep".
 */
import type {
  CompileContext,
  GamePhase,
  MarketSpec,
  OddsInputs,
  PriceProvenance,
  PriceQuote,
} from './types.js';
import { TUNABLES } from './constants.js';

// ── Model tunables (named, per the no-magic-numbers rule) ─────────────────

const REGULATION_MINUTES = 90;
const FULL_MATCH_WITH_ET_MINUTES = 120;
const HALF_TIME_MINUTE = 45;
/** Fallback expected total goals when no totals line is quoted. */
const DEFAULT_TOTAL_GOALS_LAMBDA = 2.6;
/** Fallback draw probability when no 1X2 is quoted (FT extra-time inflation). */
const DEFAULT_DRAW_PROB = 0.28;
/** Share of a team's goals scored by its headline striker (no player model). */
const PLAYER_TEAM_GOAL_SHARE = 0.3;
/** Extra-time adds 30/90 of expected regulation goals, weighted by P(draw). */
const EXTRA_TIME_GOAL_RATIO =
  (FULL_MATCH_WITH_ET_MINUTES - REGULATION_MINUTES) / REGULATION_MINUTES;

const LAMBDA_SEARCH_MIN = 1e-4;
const LAMBDA_SEARCH_MAX = 20;
const BISECTION_ITERATIONS = 80;
const PROB_EPSILON = 1e-6;

const REGULATION_INPLAY_PHASES: readonly GamePhase[] = ['H1', 'HT', 'H2'];
const EXTRA_TIME_PHASES: readonly GamePhase[] = ['ET1', 'HTET', 'ET2'];

// ── Poisson helpers ───────────────────────────────────────────────────────

export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let term = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) term *= lambda / i;
  return term;
}

/** P(X <= k) for X ~ Poisson(lambda). */
export function poissonCdf(k: number, lambda: number): number {
  if (k < 0) return 0;
  let sum = 0;
  for (let i = 0; i <= k; i += 1) sum += poissonPmf(i, lambda);
  return Math.min(1, sum);
}

/** P(X >= k) for X ~ Poisson(lambda). */
export function poissonSurvival(k: number, lambda: number): number {
  if (k <= 0) return 1;
  return Math.max(0, 1 - poissonCdf(k - 1, lambda));
}

/** Fixed-point rounds to de-condition an integer line's push-adjusted Pct. */
const PUSH_DECONDITION_ITERATIONS = 3;

function bisectLambda(kOver: number, target: number): number {
  const clamped = Math.min(1 - PROB_EPSILON, Math.max(PROB_EPSILON, target));
  let lo = LAMBDA_SEARCH_MIN;
  let hi = LAMBDA_SEARCH_MAX;
  for (let i = 0; i < BISECTION_ITERATIONS; i += 1) {
    const mid = (lo + hi) / 2;
    if (poissonSurvival(kOver, mid) < clamped) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Invert the quoted totals line to the expected total goals. Half-goal lines
 * quote an unconditional over probability — one bisection. Integer lines
 * push at exactly `line` goals, so their Pct is P(over | no push); treating
 * it as unconditional overstates lambda ~15% on real feed data. De-condition
 * by fixed point: uncond = cond * (1 - P(total = line)) at the current
 * lambda estimate, then re-invert (converges in 2-3 rounds).
 */
export function lambdaFromTotalsLine(line: number, overProb: number): number {
  const kOver = Math.floor(line) + 1;
  let lambda = bisectLambda(kOver, overProb);
  if (Number.isInteger(line)) {
    for (let i = 0; i < PUSH_DECONDITION_ITERATIONS; i += 1) {
      const unconditional = overProb * (1 - poissonPmf(line, lambda));
      lambda = bisectLambda(kOver, unconditional);
    }
  }
  return lambda;
}

// ── Context helpers ────────────────────────────────────────────────────────

/**
 * Fraction of the spec's scoring period still to be played, in regulation
 * units (1 = a full 90 ahead). Pre-match → 1. Used to scale goal rates for
 * in-play quotes.
 */
function remainingFraction(ctx: CompileContext, spec: MarketSpec): number {
  const fixture = ctx.fixture;
  if (!fixture || fixture.phase === 'NS') return 1;
  if (REGULATION_INPLAY_PHASES.includes(fixture.phase)) {
    const minute =
      fixture.minute ?? (fixture.phase === 'H1' ? 0 : HALF_TIME_MINUTE);
    return Math.max(0, REGULATION_MINUTES - minute) / REGULATION_MINUTES;
  }
  if (EXTRA_TIME_PHASES.includes(fixture.phase)) {
    if (spec.period === 'FT_90') return 0;
    const minute = fixture.minute ?? REGULATION_MINUTES;
    return (
      Math.max(0, FULL_MATCH_WITH_ET_MINUTES - minute) / REGULATION_MINUTES
    );
  }
  return 0;
}

function currentGoals(ctx: CompileContext): { p1: number; p2: number } {
  const fixture = ctx.fixture;
  if (!fixture || fixture.phase === 'NS') return { p1: 0, p2: 0 };
  return { p1: fixture.score.p1Goals, p2: fixture.score.p2Goals };
}

// ── Rate derivation (independent Poisson) ─────────────────────────────────

interface GoalRates {
  total: number;
  p1: number;
  p2: number;
  drawProb: number;
}

/** Full-match (90') goal rates implied by the totals line, split by 1X2 lean. */
function deriveGoalRates(odds: OddsInputs): GoalRates {
  const total = odds.totals
    ? lambdaFromTotalsLine(odds.totals.line, odds.totals.overProb)
    : DEFAULT_TOTAL_GOALS_LAMBDA;
  let share1 = 0.5;
  let drawProb = DEFAULT_DRAW_PROB;
  if (odds.p1x2) {
    const { home, draw, away } = odds.p1x2;
    const mass = home + draw + away;
    if (mass > 0) {
      share1 = (home + draw / 2) / mass;
      drawProb = draw / mass;
    }
  }
  return { total, p1: total * share1, p2: total * (1 - share1), drawProb };
}

/** Extra-time inflation applies only to FT-period derived claims. */
function periodRateMultiplier(spec: MarketSpec, rates: GoalRates): number {
  return spec.period === 'FT'
    ? 1 + rates.drawProb * EXTRA_TIME_GOAL_RATIO
    : 1;
}

// ── Quote assembly ────────────────────────────────────────────────────────

function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(1, Math.max(0, p));
}

function clampMultiplier(probability: number): number {
  const raw =
    probability > 0 ? 1 / probability : Number.POSITIVE_INFINITY;
  return Math.min(
    TUNABLES.MULTIPLIER_MAX,
    Math.max(TUNABLES.MULTIPLIER_MIN, raw),
  );
}

function quote(
  probability: number,
  provenance: PriceProvenance,
  odds: OddsInputs,
): PriceQuote {
  const p = clampProbability(probability);
  return {
    probability: p,
    multiplier: clampMultiplier(p),
    provenance,
    oddsMessageId: odds.oddsMessageId,
    oddsTsMs: odds.oddsTsMs,
    // Transparency for callers/logs: modelled quotes fell back to priors for
    // whichever inputs the feed did not supply. Not persisted to the DB.
    usedDefaults: { totals: odds.totals === null, p1x2: odds.p1x2 === null },
  };
}

/**
 * Thrown when the feed simply has not published the odds input a claim type
 * requires — an expected data gap, not an engine failure. Callers should
 * treat it as "no price available" (retryable), distinct from real bugs.
 */
export class MissingOddsInputError extends Error {
  readonly missingInput: 'p1x2';

  constructor(claimType: MarketSpec['claimType']) {
    super(`priceSpec: 1X2 probabilities required to price ${claimType}`);
    this.name = 'MissingOddsInputError';
    this.missingInput = 'p1x2';
  }
}

function specParticipant(spec: MarketSpec): 1 | 2 {
  const participant = spec.entityRef.participant;
  if (participant === null) {
    throw new Error(
      'priceSpec: player not yet bound to a side — cannot derive a team goal rate',
    );
  }
  return participant;
}

// ── Per-claim-type pricing ────────────────────────────────────────────────

function priceWinner(spec: MarketSpec, odds: OddsInputs): PriceQuote {
  if (!odds.p1x2) {
    throw new MissingOddsInputError(spec.claimType);
  }
  const participant = specParticipant(spec);
  const win = participant === 1 ? odds.p1x2.home : odds.p1x2.away;
  const lose = participant === 1 ? odds.p1x2.away : odds.p1x2.home;
  const draw = odds.p1x2.draw;

  if (spec.period === 'FT_90') {
    return quote(win, 'market', odds);
  }
  // FT (advancing): split the draw mass proportionally to win strength.
  const strength = win + lose;
  const drawShare = strength > 0 ? win / strength : 0.5;
  return quote(win + draw * drawShare, 'modelled', odds);
}

/** P(remaining goals cmp adjusted threshold) for a running tally. */
function tallyProbability(
  comparator: MarketSpec['comparator'],
  threshold: number,
  current: number,
  lambdaRemaining: number,
): number {
  switch (comparator) {
    case 'gte': {
      const needed = Math.ceil(threshold) - current;
      return poissonSurvival(needed, lambdaRemaining);
    }
    case 'lte': {
      const maxAllowed = Math.floor(threshold) - current;
      if (maxAllowed < 0) return 0;
      return poissonCdf(maxAllowed, lambdaRemaining);
    }
    case 'eq': {
      const needed = threshold - current;
      if (needed < 0 || !Number.isInteger(needed)) return 0;
      return poissonPmf(needed, lambdaRemaining);
    }
  }
}

function isHalfGoalLine(line: number): boolean {
  return Number.isInteger(line * 2) && !Number.isInteger(line);
}

function priceTotals(
  spec: MarketSpec,
  odds: OddsInputs,
  ctx: CompileContext,
): PriceQuote {
  // Direct market read: FT_90, half-goal line matching the feed exactly, and a
  // pure over/under comparator (integer lines have push semantics we don't
  // model — those go through Poisson).
  const direct =
    odds.totals !== null &&
    spec.period === 'FT_90' &&
    odds.totals.line === spec.threshold &&
    isHalfGoalLine(spec.threshold) &&
    (spec.comparator === 'gte' || spec.comparator === 'lte');
  if (direct && odds.totals) {
    const p =
      spec.comparator === 'gte'
        ? odds.totals.overProb
        : 1 - odds.totals.overProb;
    return quote(p, 'market', odds);
  }

  const rates = deriveGoalRates(odds);
  const remaining = remainingFraction(ctx, spec);
  const lambdaRemaining =
    rates.total * remaining * periodRateMultiplier(spec, rates);
  const goals = currentGoals(ctx);
  return quote(
    tallyProbability(
      spec.comparator,
      spec.threshold,
      goals.p1 + goals.p2,
      lambdaRemaining,
    ),
    'modelled',
    odds,
  );
}

function priceTeamScoresN(
  spec: MarketSpec,
  odds: OddsInputs,
  ctx: CompileContext,
): PriceQuote {
  const participant = specParticipant(spec);
  const rates = deriveGoalRates(odds);
  const remaining = remainingFraction(ctx, spec);
  const lambdaTeam =
    (participant === 1 ? rates.p1 : rates.p2) *
    remaining *
    periodRateMultiplier(spec, rates);
  const goals = currentGoals(ctx);
  const current = participant === 1 ? goals.p1 : goals.p2;
  return quote(
    tallyProbability(spec.comparator, spec.threshold, current, lambdaTeam),
    'modelled',
    odds,
  );
}

function priceBtts(
  spec: MarketSpec,
  odds: OddsInputs,
  ctx: CompileContext,
): PriceQuote {
  const rates = deriveGoalRates(odds);
  const remaining = remainingFraction(ctx, spec);
  const inflation = periodRateMultiplier(spec, rates);
  const goals = currentGoals(ctx);
  const pSide = (lambda: number, already: number): number =>
    already >= 1 ? 1 : 1 - Math.exp(-lambda * remaining * inflation);
  return quote(
    pSide(rates.p1, goals.p1) * pSide(rates.p2, goals.p2),
    'modelled',
    odds,
  );
}

function pricePlayerScoresN(
  spec: MarketSpec,
  odds: OddsInputs,
  ctx: CompileContext,
): PriceQuote {
  // A player not yet bound to a side (pre-lineup) prices off the neutral
  // team rate (total/2) so the pending_lineup mint path stays reachable;
  // the reducer binds the real side when lineups land.
  const participant = spec.entityRef.participant;
  const rates = deriveGoalRates(odds);
  const remaining = remainingFraction(ctx, spec);
  const teamRate =
    participant === null
      ? rates.total / 2
      : participant === 1
        ? rates.p1
        : rates.p2;
  const lambdaPlayer =
    teamRate *
    PLAYER_TEAM_GOAL_SHARE *
    remaining *
    periodRateMultiplier(spec, rates);
  // Player claims mint pre-kickoff only, so the running tally is always 0.
  return quote(
    tallyProbability(spec.comparator, spec.threshold, 0, lambdaPlayer),
    'modelled',
    odds,
  );
}

// ── Entry point ───────────────────────────────────────────────────────────

export function priceSpec(
  spec: MarketSpec,
  odds: OddsInputs,
  ctx: CompileContext,
): PriceQuote {
  switch (spec.claimType) {
    case 'match_winner':
    case 'comeback':
      return priceWinner(spec, odds);
    case 'totals_ou':
      return priceTotals(spec, odds, ctx);
    case 'team_scores_n':
      return priceTeamScoresN(spec, odds, ctx);
    case 'btts':
      return priceBtts(spec, odds, ctx);
    case 'player_scores_n':
      return pricePlayerScoresN(spec, odds, ctx);
  }
}
