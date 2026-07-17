import { describe, expect, it } from 'vitest';
import {
  combineOddsSnapshot,
  fixtureRecordSchema,
  isOddsSuspended,
  normalizeScores,
  oddsRecordSchema,
  scoresRecordSchema,
  silentLogger,
} from '@calledit/txline';
import type { MatchEvent } from '@calledit/market-engine';
import { materializeMatch } from './materialize.js';
import { PLAYER_IDS, WORLDCUP_FINAL } from './scripts/worldcup-final.js';

const KICKOFF = 1_790_000_000_000;
const REAL_TIME = 1;

function materialized(timeScale = REAL_TIME) {
  return materializeMatch({
    script: WORLDCUP_FINAL,
    fixtureId: 9001,
    kickoffWallMs: KICKOFF,
    timeScale,
    scheduledAtMs: KICKOFF - 60 * 60_000,
  });
}

describe('materializeMatch — wire fidelity', () => {
  it('every scores record parses through the txline schema', () => {
    for (const { record } of materialized().scores) {
      const parsed = scoresRecordSchema.safeParse(record);
      expect(parsed.success, JSON.stringify(record).slice(0, 200)).toBe(true);
    }
  });

  it('every odds record parses through the txline schema', () => {
    for (const { record } of materialized().odds) {
      expect(oddsRecordSchema.safeParse(record).success).toBe(true);
    }
  });

  it('the fixture record parses through the txline schema', () => {
    expect(fixtureRecordSchema.safeParse(materialized().fixture).success).toBe(true);
  });

  it('seqs are strictly increasing and wall times are monotonic', () => {
    const { scores } = materialized();
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]!.record.Seq as number).toBe((scores[i - 1]!.record.Seq as number) + 1);
      expect(scores[i]!.wallTs).toBeGreaterThanOrEqual(scores[i - 1]!.wallTs);
    }
  });
});

describe('materializeMatch — normalizes into the expected match story', () => {
  const events: MatchEvent[] = normalizeScores(
    materialized().scores.map((entry) => entry.record),
    KICKOFF,
    { logger: silentLogger },
  );

  it('tells the full story: lineup, goals, VAR discard, full time', () => {
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain('lineup');
    expect(kinds).toContain('possible_event');
    expect(kinds).toContain('var_check');
    expect(kinds).toContain('goal_discarded');
    expect(kinds).toContain('var_end');
    expect(kinds.filter((kind) => kind === 'goal')).toHaveLength(5); // 4 stand + 1 later discarded
  });

  it('the discard reverses the Álvarez goal seq and decrements the score', () => {
    const alvarezGoal = events.find(
      (event) => event.kind === 'goal' && event.detail?.playerNormativeId === PLAYER_IDS.ALVAREZ,
    );
    const discard = events.find((event) => event.kind === 'goal_discarded');
    expect(alvarezGoal).toBeDefined();
    expect(discard?.detail?.reversesSeq).toBe(alvarezGoal?.seq);
    expect(discard?.score.p2.goals).toBe(1); // back to Messi's lone goal
  });

  it('every settlement-grade goal is confirmed', () => {
    for (const event of events) {
      if (event.kind === 'goal') expect(event.confirmed).toBe(true);
    }
  });

  it('finishes 3-1 with a terminal phase and intact goals-90', () => {
    const fullTime = events.at(-1);
    expect(fullTime?.kind).toBe('phase_change');
    expect(fullTime?.phase).toBe('F');
    expect(fullTime?.score.p1.goals).toBe(3);
    expect(fullTime?.score.p2.goals).toBe(1);
    expect(fullTime?.score.p1Goals90).toBe(3);
    expect(fullTime?.score.p2Goals90).toBe(1);
  });

  it('Mbappé finishes with a brace', () => {
    const mbappeGoals = events.filter(
      (event) => event.kind === 'goal' && event.detail?.playerNormativeId === PLAYER_IDS.MBAPPE,
    );
    expect(mbappeGoals).toHaveLength(2);
  });
});

describe('materializeMatch — odds', () => {
  it('pre-match snapshot combines into usable 1X2 + totals inputs', () => {
    const preMatch = materialized()
      .odds.filter((entry) => entry.wallTs < KICKOFF)
      .map((entry) => entry.record);
    const inputs = combineOddsSnapshot(preMatch, { logger: silentLogger });
    expect(inputs?.p1x2).toEqual({ home: 0.425, draw: 0.26, away: 0.315 });
    expect(inputs?.totals?.line).toBe(2.5);
  });

  it('scripted suspensions mark the book off the board', () => {
    const suspended = materialized().odds.filter((entry) =>
      isOddsSuspended(oddsRecordSchema.parse(entry.record)),
    );
    expect(suspended.length).toBeGreaterThanOrEqual(2);
  });

  it('time compression squeezes in-play gaps but not pre-match lead', () => {
    const TEN_X = 10;
    const real = materialized();
    const fast = materialized(TEN_X);
    const span = (entries: Array<{ wallTs: number }>): number =>
      entries.at(-1)!.wallTs - entries.find((entry) => entry.wallTs >= KICKOFF)!.wallTs;
    expect(span(fast.scores)).toBeLessThan(span(real.scores) / (TEN_X - 1));
    const firstOdds = fast.odds[0]!;
    expect(firstOdds.wallTs).toBe(KICKOFF - 45 * 60_000); // pre-match stays real
  });
});
