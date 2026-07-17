/**
 * Locks the scripted feed to the REAL France 0–2 Spain semifinal
 * (2026-07-14): scoreline, scorers, minutes, the no-VAR penalty, the Rabiot
 * booking, and the real pre-match book. If someone edits the script away from
 * the historical record, these fail.
 */

import { describe, expect, it } from 'vitest';
import {
  combineOddsSnapshot,
  normalizeScores,
  oddsRecordSchema,
  scoresRecordSchema,
  silentLogger,
} from '@calledit/txline';
import type { MatchEvent } from '@calledit/market-engine';
import { materializeMatch } from './materialize.js';
import {
  FRANCE_PLAYER_IDS,
  FRANCE_SPAIN_SEMI,
  SPAIN_PLAYER_IDS,
} from './scripts/france-spain-20260714.js';

const KICKOFF = 1_789_000_000_000;
const REAL_TIME = 1;

const match = materializeMatch({
  script: FRANCE_SPAIN_SEMI,
  fixtureId: 9001,
  kickoffWallMs: KICKOFF,
  timeScale: REAL_TIME,
  scheduledAtMs: KICKOFF - 60 * 60_000,
});

const events: MatchEvent[] = normalizeScores(
  match.scores.map((entry) => entry.record),
  KICKOFF,
  { logger: silentLogger },
);

describe('France 0–2 Spain — the record matches history', () => {
  it('all records still parse through the txline schemas', () => {
    for (const { record } of match.scores) {
      expect(scoresRecordSchema.safeParse(record).success).toBe(true);
    }
    for (const { record } of match.odds) {
      expect(oddsRecordSchema.safeParse(record).success).toBe(true);
    }
  });

  it('ends 0–2 to Spain at full time, both goals inside 90', () => {
    const fullTime = events.at(-1);
    expect(fullTime?.kind).toBe('phase_change');
    expect(fullTime?.phase).toBe('F');
    expect(fullTime?.score.p1.goals).toBe(0);
    expect(fullTime?.score.p2.goals).toBe(2);
    expect(fullTime?.score.p2Goals90).toBe(2);
  });

  it("Oyarzabal's 22nd-minute penalty is the opener", () => {
    const goals = events.filter((event) => event.kind === 'goal');
    const opener = goals[0];
    expect(opener?.detail?.playerNormativeId).toBe(SPAIN_PLAYER_IDS.OYARZABAL);
    expect(opener?.detail?.goalType).toBe('penalty');
    expect(opener?.minute).toBe(22);
    expect(opener?.confirmed).toBe(true);
  });

  it("Porro's 58th-minute goal is the second — and there is no VAR overturn", () => {
    const goals = events.filter((event) => event.kind === 'goal');
    expect(goals).toHaveLength(2);
    expect(goals[1]?.detail?.playerNormativeId).toBe(SPAIN_PLAYER_IDS.PORRO);
    expect(goals[1]?.minute).toBe(58);
    // Quick whistle, no review: the real match had no VAR events at all.
    const kinds = events.map((event) => event.kind);
    expect(kinds).not.toContain('var_check');
    expect(kinds).not.toContain('goal_discarded');
  });

  it('the penalty award freezes the market before the kick', () => {
    const penaltyFlag = events.find((event) => event.kind === 'possible_event');
    const opener = events.find((event) => event.kind === 'goal');
    expect(penaltyFlag).toBeDefined();
    expect(opener).toBeDefined();
    expect(penaltyFlag!.seq).toBeLessThan(opener!.seq);
  });

  it("Rabiot's 10th-minute booking is the only card", () => {
    const cards = events.filter((event) => event.kind === 'card');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.detail?.card).toBe('yellow');
    expect(cards[0]?.detail?.playerNormativeId).toBe(FRANCE_PLAYER_IDS.RABIOT);
    expect(cards[0]?.minute).toBe(10);
  });

  it('the pre-match book is the demargined FanDuel line — France favorites', () => {
    const preMatch = match.odds
      .filter((entry) => entry.wallTs < KICKOFF)
      .map((entry) => entry.record);
    const inputs = combineOddsSnapshot(preMatch, { logger: silentLogger });
    expect(inputs?.p1x2?.home).toBeCloseTo(0.365, 3);
    expect(inputs?.p1x2?.away).toBeCloseTo(0.31, 3);
    expect(inputs?.totals?.line).toBe(2.5);
  });

  it('both real starting XIs ride the lineup record', () => {
    const lineupRecord = match.scores.find((entry) => entry.record.Lineups !== undefined);
    const lineups = lineupRecord?.record.Lineups as Array<{
      PreferredName: string;
      Lineups: Array<{ Starter: boolean; Player: { PreferredName: string } }>;
    }>;
    expect(lineups.map((team) => team.PreferredName)).toEqual(['France', 'Spain']);
    const starters = (team: number): string[] =>
      lineups[team]!.Lineups.filter((slot) => slot.Starter).map((slot) => slot.Player.PreferredName);
    expect(starters(0)).toHaveLength(11);
    expect(starters(1)).toHaveLength(11);
    expect(starters(0)).toContain('Kylian Mbappé');
    expect(starters(1)).toContain('Lamine Yamal');
  });
});
