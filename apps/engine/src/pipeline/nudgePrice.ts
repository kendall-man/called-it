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

export async function guessNudgeProbability(
  deps: Deps,
  text: string,
  claimTypeGuess: string | null,
): Promise<NudgePrice | null> {
  try {
    const fixture = await findFixtureForText(deps, text);
    if (!fixture) return null;
    const odds = await deps.tx.fetchOdds(fixture.fixture_id);
    if (!odds) return null;

    let probability: number | null = null;
    if (claimTypeGuess === 'match_winner' && odds.p1x2) {
      const backsHome = mentionsTeam(text, fixture.p1_name);
      probability = backsHome ? odds.p1x2.home : odds.p1x2.away;
    } else if (claimTypeGuess === 'totals_ou' && odds.totals) {
      probability = odds.totals.overProb;
    }
    if (probability === null || !Number.isFinite(probability)) return null;
    if (probability <= 0 || probability >= 1) return null;
    return {
      probability,
      probabilityPct: Math.max(1, Math.round(probability * 100)),
      fixtureId: fixture.fixture_id,
    };
  } catch {
    return null;
  }
}
