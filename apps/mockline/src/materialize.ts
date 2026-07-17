/**
 * Script → wire records. Walks the timeline in match order, maintains running
 * score/phase/clock state, and emits records in the PascalCase shape the live
 * devnet wire uses (numeric StatusId, Data/Score envelopes, Confirmed
 * affirmative on goals). Fidelity is enforced by tests that round-trip every
 * emitted record through @calledit/txline's schemas and normalizers.
 */

import type {
  MatchScript,
  Materialized,
  MaterializedMatch,
  TeamSide,
  TimelineEntry,
  WireRecord,
} from './types.js';
import { WIRE_STATUS, type WireStatusName } from './types.js';

/** Wall-clock length of the scripted half-time break (before compression). */
const HT_BREAK_MS = 10 * 60_000;
/** Match-clock end of first-half entries — the break is inserted after this. */
const H1_END_MS = 45 * 60_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;
/** Record-level event Ids are per-fixture counters on the real feed. */
const FIRST_EVENT_ID = 100;
const SPORT_ID_SOCCER = 10;
const COUNTRY_ID_STAGING = 900;

/** Statuses during which the match clock runs. */
const CLOCK_RUNNING_STATUSES: ReadonlySet<WireStatusName> = new Set(['H1', 'H2', 'ET1', 'ET2']);
/** Statuses that mean regulation/ET play has begun (liveness for records). */
const IN_PLAY_OR_LATER: ReadonlySet<WireStatusName> = new Set([
  'H1', 'HT', 'H2', 'F', 'WET', 'ET1', 'HTET', 'ET2', 'FET', 'A',
]);

interface PeriodTally {
  Goals: number;
  YellowCards: number;
  RedCards: number;
  Corners: number;
}

const emptyTally = (): PeriodTally => ({ Goals: 0, YellowCards: 0, RedCards: 0, Corners: 0 });

type PeriodKey = 'H1' | 'H2' | 'ET1' | 'ET2';

/** Which period bucket an in-play entry lands in, from the current status. */
function periodForStatus(status: WireStatusName): PeriodKey {
  switch (status) {
    case 'ET1':
      return 'ET1';
    case 'ET2':
      return 'ET2';
    case 'H2':
    case 'F':
    case 'WET':
      return 'H2';
    default:
      return 'H1';
  }
}

class TeamScore {
  readonly periods = new Map<PeriodKey, PeriodTally>();

  bucket(period: PeriodKey): PeriodTally {
    const existing = this.periods.get(period);
    if (existing) return existing;
    const fresh = emptyTally();
    this.periods.set(period, fresh);
    return fresh;
  }

  /** Wire Score object for one participant: per-period buckets + Total. */
  toWire(): Record<string, PeriodTally> {
    const wire: Record<string, PeriodTally> = {};
    const total = emptyTally();
    for (const [key, tally] of this.periods) {
      wire[key] = { ...tally };
      total.Goals += tally.Goals;
      total.YellowCards += tally.YellowCards;
      total.RedCards += tally.RedCards;
      total.Corners += tally.Corners;
    }
    wire.Total = total;
    return wire;
  }
}

/**
 * Wall-time offset from kickoff: match time, plus the half-time break for
 * everything at/after the scripted H2 restart (H1 stoppage time stays in the
 * first-half wall segment).
 */
function wallOffsetMs(matchMs: number, h2StartMs: number): number {
  if (matchMs < h2StartMs) return matchMs;
  return matchMs + HT_BREAK_MS;
}

interface MaterializeArgs {
  script: MatchScript;
  fixtureId: number;
  /** Absolute wall ms of kickoff. */
  kickoffWallMs: number;
  /** ≥ 1; in-play wall gaps shrink by this factor (pre-match stays real-time). */
  timeScale: number;
  /** Wall ms the match was scheduled — clamps nothing, recorded for status. */
  scheduledAtMs: number;
}

export function materializeMatch(args: MaterializeArgs): MaterializedMatch {
  const { script, fixtureId, kickoffWallMs, timeScale, scheduledAtMs } = args;
  if (timeScale < 1) throw new Error('timeScale must be >= 1');

  const entries = [...script.timeline].sort((a, b) => a.atMs - b.atMs);
  const h2StartMs =
    entries.find((entry) => entry.kind === 'phase' && entry.status === 'H2')?.atMs ??
    H1_END_MS + MS_PER_SECOND;

  const scores: Array<Materialized<WireRecord>> = [];
  const odds: Array<Materialized<WireRecord>> = [];

  let seq = 0;
  let nextEventId = FIRST_EVENT_ID;
  let oddsCounter = 0;
  let status: WireStatusName = 'NS';
  const goalIdByTag = new Map<string, number>();
  const goalPeriodByTag = new Map<string, { side: TeamSide; period: PeriodKey }>();
  const teamScores: Record<TeamSide, TeamScore> = { 1: new TeamScore(), 2: new TeamScore() };

  const wallTsOf = (matchMs: number): number =>
    matchMs < 0
      ? kickoffWallMs + matchMs // pre-match offsets are real wall time
      : kickoffWallMs + Math.round(wallOffsetMs(matchMs, h2StartMs) / timeScale);

  const clockOf = (matchMs: number): { Running: boolean; Seconds: number } => ({
    Running: CLOCK_RUNNING_STATUSES.has(status),
    Seconds: Math.max(0, Math.floor(matchMs / MS_PER_SECOND)),
  });

  const minuteOf = (matchMs: number): number => Math.floor(matchMs / MS_PER_MINUTE) + 1;

  const baseScoresRecord = (entry: TimelineEntry): WireRecord => {
    seq += 1;
    return {
      FixtureId: fixtureId,
      Seq: seq,
      Ts: wallTsOf(entry.atMs),
      Action: 'Insert',
      GameState: 'scheduled', // the live wire keeps this literal all match
      StartTime: kickoffWallMs,
      CompetitionId: script.competitionId,
      CountryId: COUNTRY_ID_STAGING,
      SportId: SPORT_ID_SOCCER,
      IsTeam: true,
      Participant1Id: script.home.participantId,
      Participant2Id: script.away.participantId,
      Participant1IsHome: true,
      Type: 'Soccer',
      StatusId: WIRE_STATUS[status],
      Clock: clockOf(entry.atMs),
      Score: { Participant1: teamScores[1].toWire(), Participant2: teamScores[2].toWire() },
      Data: {},
      Stats: {},
    };
  };

  const pushScores = (record: WireRecord): void => {
    scores.push({ wallTs: record.Ts as number, record });
  };

  for (const entry of entries) {
    switch (entry.kind) {
      case 'phase': {
        status = entry.status;
        const record = baseScoresRecord(entry);
        record.StatusId = WIRE_STATUS[status];
        record.Clock = clockOf(entry.atMs);
        if (IN_PLAY_OR_LATER.has(status)) record.GameState = 'scheduled';
        pushScores(record);
        break;
      }

      case 'lineups': {
        const record = baseScoresRecord(entry);
        record.Lineups = [script.home, script.away].map((team) => ({
          NormativeId: team.participantId,
          PreferredName: team.name,
          Lineups: team.players.map((player) => ({
            Starter: player.starter,
            Player: {
              NormativeId: player.normativeId,
              PreferredName: player.name,
              Team: team.name,
            },
          })),
        }));
        pushScores(record);
        break;
      }

      case 'goal': {
        const side = entry.team;
        const period = periodForStatus(status);
        teamScores[side].bucket(period).Goals += 1;
        const eventId = nextEventId++;
        if (entry.tag !== undefined) {
          goalIdByTag.set(entry.tag, eventId);
          goalPeriodByTag.set(entry.tag, { side, period });
        }
        const record = baseScoresRecord(entry);
        record.Id = eventId;
        record.Confirmed = true; // settlement-grade goals are affirmative
        record.Data = {
          Goal: true,
          Participant: side,
          Minutes: minuteOf(entry.atMs),
          ...(entry.playerId !== undefined ? { PlayerId: entry.playerId } : {}),
          ...(entry.goalType !== undefined ? { GoalType: entry.goalType } : {}),
          ...(entry.goalType === 'Penalty' ? { Penalty: true } : {}),
        };
        pushScores(record);
        break;
      }

      case 'discard': {
        const originalId = goalIdByTag.get(entry.ofTag);
        const placement = goalPeriodByTag.get(entry.ofTag);
        if (originalId === undefined || placement === undefined) {
          throw new Error(`discard references unknown goal tag "${entry.ofTag}"`);
        }
        teamScores[placement.side].bucket(placement.period).Goals -= 1;
        const record = baseScoresRecord(entry);
        record.Id = originalId; // the feed links reversals via the shared Id
        record.Action = 'action_discarded';
        record.Data = {}; // observed live: discard envelopes arrive empty
        pushScores(record);
        break;
      }

      case 'var_check': {
        const record = baseScoresRecord(entry);
        record.Id = nextEventId++;
        record.Data = { VAR: true, Type: 'VAR', Minutes: minuteOf(entry.atMs) };
        pushScores(record);
        break;
      }

      case 'var_end': {
        const record = baseScoresRecord(entry);
        record.Id = nextEventId++;
        record.Data = { VAR: false, Type: 'VAR check ended', Minutes: minuteOf(entry.atMs) };
        pushScores(record);
        break;
      }

      case 'card': {
        const side = entry.team;
        const period = periodForStatus(status);
        const bucket = teamScores[side].bucket(period);
        if (entry.card === 'yellow') bucket.YellowCards += 1;
        else bucket.RedCards += 1;
        const record = baseScoresRecord(entry);
        record.Id = nextEventId++;
        record.Data = {
          ...(entry.card === 'yellow' ? { YellowCard: true } : { RedCard: true }),
          Participant: side,
          Minutes: minuteOf(entry.atMs),
          ...(entry.playerId !== undefined ? { PlayerId: entry.playerId } : {}),
        };
        pushScores(record);
        break;
      }

      case 'possible_event': {
        const record = baseScoresRecord(entry);
        const state = {
          PossibleEvent: entry.flag === 'penalty' ? { Penalty: true } : { Goal: true },
        };
        if (entry.team === 1) record.Parti1State = state;
        else record.Parti2State = state;
        pushScores(record);
        break;
      }

      case 'additional_time': {
        const record = baseScoresRecord(entry);
        record.Action = 'additional_time';
        record.Data = { Minutes: entry.minutes };
        pushScores(record);
        break;
      }

      case 'comment': {
        const record = baseScoresRecord(entry);
        record.Action = 'comment';
        pushScores(record);
        break;
      }

      case 'odds': {
        const wallTs = wallTsOf(entry.atMs);
        const gameState = entry.suspended === true ? 'Suspended' : 'Running';
        const inRunning = entry.atMs >= 0;
        if (entry.oneX2 !== undefined || entry.suspended === true) {
          oddsCounter += 1;
          const oneX2 = entry.oneX2 ?? { home: 33.3, draw: 33.3, away: 33.4 };
          odds.push({
            wallTs,
            record: {
              FixtureId: fixtureId,
              MessageId: `m${fixtureId}-${oddsCounter}`,
              Ts: wallTs,
              Bookmaker: 'StablePrice',
              BookmakerId: 1,
              SuperOddsType: '1X2_PARTICIPANT_RESULT',
              GameState: gameState,
              InRunning: inRunning,
              PriceNames: ['1', 'X', '2'],
              Prices: [oneX2.home, oneX2.draw, oneX2.away].map(pctToPriceMilli),
              Pct: [oneX2.home, oneX2.draw, oneX2.away].map(formatPct),
            },
          });
        }
        if (entry.totals !== undefined) {
          oddsCounter += 1;
          const { line, overPct, underPct } = entry.totals;
          odds.push({
            wallTs,
            record: {
              FixtureId: fixtureId,
              MessageId: `m${fixtureId}-${oddsCounter}`,
              Ts: wallTs,
              Bookmaker: 'StablePrice',
              BookmakerId: 1,
              SuperOddsType: 'OVERUNDER_PARTICIPANT_GOALS',
              GameState: gameState,
              InRunning: inRunning,
              MarketParameters: `total=${line}`,
              PriceNames: ['Over', 'Under'],
              Prices: [overPct, underPct].map(pctToPriceMilli),
              Pct: [overPct, underPct].map(formatPct),
            },
          });
        }
        break;
      }
    }
  }

  const fixture: WireRecord = {
    FixtureId: fixtureId,
    StartTime: kickoffWallMs,
    Ts: scheduledAtMs,
    Competition: script.competition,
    CompetitionId: script.competitionId,
    FixtureGroupId: 1,
    Participant1Id: script.home.participantId,
    Participant1: script.home.name,
    Participant2Id: script.away.participantId,
    Participant2: script.away.name,
    Participant1IsHome: true,
  };

  return {
    fixtureId,
    script,
    kickoffWallMs,
    timeScale,
    scheduledAtMs,
    fixture,
    scores,
    odds,
  };
}

/** Milli-price a bookmaker would quote at ~fair odds for a given Pct. */
function pctToPriceMilli(pct: number): number {
  const FULL_PROBABILITY_PCT = 100;
  const MILLI = 1000;
  return Math.round((FULL_PROBABILITY_PCT / Math.max(pct, 0.1)) * MILLI);
}

/** TxLINE Pct strings are demargined percentages with 3 decimals. */
function formatPct(pct: number): string {
  return pct.toFixed(3);
}
