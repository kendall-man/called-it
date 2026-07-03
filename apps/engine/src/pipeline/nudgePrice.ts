/**
 * Best-effort probability for the one-line priced nudge, computed BEFORE any
 * expensive parse (the full parse runs only after "Make him prove it").
 * Heuristic: ground a fixture by team-name mention, then read the classifier's
 * claim-type guess against the latest odds snapshot. Returns null whenever a
 * clean number isn't available — the nudge falls back to unpriced copy.
 */

import type { Deps, FixtureRow } from '../ports.js';

const NUDGE_LOOKBACK_MS = 6 * 60 * 60_000;
const NUDGE_LOOKAHEAD_MS = 36 * 60 * 60_000;

export interface NudgePrice {
  /** Demargined probability in (0, 1). */
  probability: number;
  probabilityPct: number;
  fixtureId: number;
}

function mentionsTeam(text: string, teamName: string): boolean {
  if (teamName.length < 3) return false;
  return text.toLowerCase().includes(teamName.toLowerCase());
}

export async function findFixtureForText(deps: Deps, text: string): Promise<FixtureRow | null> {
  const nowMs = deps.now();
  const fixtures = await deps.db
    .fixturesBetween(nowMs - NUDGE_LOOKBACK_MS, nowMs + NUDGE_LOOKAHEAD_MS)
    .catch(() => [] as FixtureRow[]);
  for (const fixture of fixtures) {
    if (mentionsTeam(text, fixture.p1_name) || mentionsTeam(text, fixture.p2_name)) {
      return fixture;
    }
  }
  return null;
}

/**
 * Negated claims ("Ghana will lose", "no way they win") invert what the
 * heuristic would price. It is a best-effort nudge, so declining to price
 * beats advertising a number for the OPPOSITE of what was claimed. Covers
 * both ASCII and smart-punctuation apostrophes ("won't"/"won’t").
 */
const NEGATION_RE = /\b(?:lose|loses|losing|lost|won[’']?t|will\s+not|can[’']?t|cannot|no\s+way)\b/i;

const UNDER_RE = /\bunder\b/i;

function unpriced(deps: Deps, reason: string, fixtureId: number | null): null {
  deps.log.info('nudge_unpriced', { reason, fixtureId });
  return null;
}

export async function guessNudgeProbability(
  deps: Deps,
  text: string,
  claimTypeGuess: string | null,
): Promise<NudgePrice | null> {
  let fixtureId: number | null = null;
  try {
    const fixture = await findFixtureForText(deps, text);
    if (!fixture) return unpriced(deps, 'no_fixture_match', null);
    fixtureId = fixture.fixture_id;
    if (NEGATION_RE.test(text)) return unpriced(deps, 'negated_claim', fixtureId);
    const fetched = await deps.tx.fetchOdds(fixture.fixture_id);
    if (fetched.kind !== 'ok') return unpriced(deps, `odds_${fetched.kind}`, fixtureId);
    const odds = fetched.odds;

    let probability: number | null = null;
    if (claimTypeGuess === 'match_winner' && odds.p1x2) {
      const mentionsP1 = mentionsTeam(text, fixture.p1_name);
      const mentionsP2 = mentionsTeam(text, fixture.p2_name);
      // Both teams (or neither) named — no way to tell which side is backed,
      // and guessing risks quoting the wrong outcome in the group's face.
      if (mentionsP1 === mentionsP2) return unpriced(deps, 'ambiguous_side', fixtureId);
      probability = mentionsP1 ? odds.p1x2.home : odds.p1x2.away;
    } else if (claimTypeGuess === 'totals_ou' && odds.totals) {
      probability = UNDER_RE.test(text) ? 1 - odds.totals.overProb : odds.totals.overProb;
    }
    if (probability === null || !Number.isFinite(probability)) {
      return unpriced(deps, 'no_usable_input', fixtureId);
    }
    if (probability <= 0 || probability >= 1) {
      return unpriced(deps, 'probability_out_of_range', fixtureId);
    }
    return {
      probability,
      probabilityPct: Math.max(1, Math.round(probability * 100)),
      fixtureId: fixture.fixture_id,
    };
  } catch (err) {
    deps.log.warn('nudge_price_failed', { fixtureId, error: String(err) });
    return null;
  }
}
