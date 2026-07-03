/**
 * CompileContext construction — the bridge from DB rows to the pure
 * market-engine compiler/pricer.
 */

import type { CompileContext, ScoreState } from '@calledit/market-engine';
import type { Deps, FixtureRow } from '../ports.js';

export function readGoals(score: Record<string, unknown>, side: 'p1' | 'p2'): number {
  const team = score[side];
  if (team && typeof team === 'object' && 'goals' in team) {
    const goals = (team as { goals?: unknown }).goals;
    if (typeof goals === 'number') return goals;
  }
  return 0;
}

export function fixtureToContextFixture(row: FixtureRow): NonNullable<CompileContext['fixture']> {
  const score = (row.score ?? {}) as Partial<ScoreState> & Record<string, unknown>;
  return {
    fixtureId: row.fixture_id,
    p1Name: row.p1_name,
    p2Name: row.p2_name,
    kickoffMs: row.kickoff_at ? Date.parse(row.kickoff_at) : 0,
    phase: row.phase,
    minute: row.minute,
    score: { p1Goals: readGoals(score, 'p1'), p2Goals: readGoals(score, 'p2') },
    lastSeq: row.last_seq,
    coverageUnreliable: row.coverage_unreliable,
  };
}

export async function buildCompileContext(
  deps: Deps,
  fixtureId: number | null,
): Promise<CompileContext> {
  if (fixtureId === null) {
    return { fixture: null, knownPlayers: [], nowMs: deps.now() };
  }
  const [fixture, players] = await Promise.all([
    deps.db.getFixture(fixtureId),
    deps.db.playersForFixture(fixtureId).catch(() => []),
  ]);
  return {
    fixture: fixture ? fixtureToContextFixture(fixture) : null,
    knownPlayers: players.map((p) => ({
      normativeId: p.normativeId,
      name: p.name,
      participant: p.participant,
    })),
    nowMs: deps.now(),
  };
}
