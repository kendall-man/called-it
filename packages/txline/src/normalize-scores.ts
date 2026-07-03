import type {
  GamePhase,
  MatchEvent,
  MatchEventKind,
  ScoreState,
  TeamStats,
} from '@calledit/market-engine';
import { consoleLogger, type TxlineLogger } from './logging.js';
import {
  scoresRecordSchema,
  type ScoresRecord,
  type SoccerPeriodScore,
  type SoccerTotalScore,
} from './schemas.js';

// ── statusSoccerId → GamePhase ────────────────────────────────────────────

/**
 * TxLINE soccer statuses (spec: SoccerFixtureStatus oneOf) mapped to domain
 * GamePhase. Deliberate approximations:
 *  - WET ("waiting for extra time") → HTET: regulation is over but nothing is
 *    terminal yet; HTET is the closest non-terminal ET break. Mapping to F/FET
 *    would wrongly settle FT markets on a match still heading to extra time.
 *  - WPE ("waiting for penalties") → PE for the same reason (FET is terminal).
 *  - TXCC/TXCS (TxODDS coverage cancelled/stopped) → COV_LOST.
 */
export const SOCCER_STATUS_TO_PHASE: Readonly<Record<string, GamePhase>> = {
  NS: 'NS',
  H1: 'H1',
  HT: 'HT',
  H2: 'H2',
  F: 'F',
  WET: 'HTET',
  ET1: 'ET1',
  HTET: 'HTET',
  ET2: 'ET2',
  FET: 'FET',
  WPE: 'PE',
  PE: 'PE',
  FPE: 'FPE',
  I: 'INT',
  A: 'ABD',
  C: 'CAN',
  P: 'POST',
  TXCC: 'COV_LOST',
  TXCS: 'COV_LOST',
};

/** Raw statuses signalling TxLINE coverage loss (still useful pre-mapping). */
const COVERAGE_LOST_STATUSES = new Set(['TXCC', 'TXCS']);

/**
 * Mapped phases that can only occur once regulation ended — used to switch
 * goals-90 bookkeeping from "all goals" to "H1+H2 only".
 */
const PAST_REGULATION_PHASES: ReadonlySet<GamePhase> = new Set([
  'ET1',
  'HTET',
  'ET2',
  'FET',
  'PE',
  'FPE',
]);

/**
 * The spec encodes enum-ish values (statusSoccerId, GoalType) as a oneOf of
 * empty named objects. Depending on the server serializer that arrives as a
 * bare string ("FET"), a single-key wrapper ({"FET":{}}), or a discriminator
 * object ({"type":"FET"}). Accept all three.
 */
export function coerceEnumName(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (raw !== null && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (typeof record['type'] === 'string') return record['type'];
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] !== undefined) return keys[0];
  }
  return null;
}

/** Maps a raw `statusSoccerId` value to a GamePhase; null when unrecognized. */
export function mapSoccerStatusToGamePhase(raw: unknown): GamePhase | null {
  const name = coerceEnumName(raw);
  if (name === null) return null;
  return SOCCER_STATUS_TO_PHASE[name] ?? null;
}

/** Last-resort phase inference from the free-form `gameState` string. */
function phaseFromGameState(gameState: string | undefined): GamePhase | null {
  if (gameState === undefined) return null;
  if (/pre|sched|not.?started/i.test(gameState)) return 'NS';
  if (/finish|final|ended|complete|full.?time/i.test(gameState)) return 'F';
  if (/half.?time/i.test(gameState)) return 'HT';
  if (/live|running|play|progress/i.test(gameState)) return 'H1';
  return null;
}

// ── action classification ─────────────────────────────────────────────────

/**
 * `action` values are inventoried empirically (spec types them as plain
 * string); match generously on stems so casing/tense variants still classify.
 */
const AMEND_ACTION_PATTERN = /amend|updat|correct|edit/i;
const DISCARD_ACTION_PATTERN = /discard|delet|cancel|remov|void/i;

type ActionClass = 'new' | 'amend' | 'discard';

function classifyAction(action: string): ActionClass {
  if (DISCARD_ACTION_PATTERN.test(action)) return 'discard';
  if (AMEND_ACTION_PATTERN.test(action)) return 'amend';
  return 'new';
}

// ── score state ───────────────────────────────────────────────────────────

const ZERO_TEAM_STATS: TeamStats = { goals: 0, yellowCards: 0, redCards: 0, corners: 0 };

function sumPeriods(periods: Array<SoccerPeriodScore | undefined>): SoccerPeriodScore | null {
  const present = periods.filter((p): p is SoccerPeriodScore => p !== undefined);
  if (present.length === 0) return null;
  return present.reduce(
    (acc, p) => ({
      Goals: acc.Goals + p.Goals,
      YellowCards: acc.YellowCards + p.YellowCards,
      RedCards: acc.RedCards + p.RedCards,
      Corners: acc.Corners + p.Corners,
    }),
    { Goals: 0, YellowCards: 0, RedCards: 0, Corners: 0 },
  );
}

interface ParticipantAggregate {
  stats: TeamStats;
  /** H1+H2 goals when the breakdown exists; null otherwise. */
  regulationGoals: number | null;
  sawExtraTimePeriods: boolean;
}

function aggregateParticipant(total: SoccerTotalScore | undefined): ParticipantAggregate {
  if (total === undefined) {
    return { stats: ZERO_TEAM_STATS, regulationGoals: null, sawExtraTimePeriods: false };
  }
  // PE (shootout) goals are intentionally excluded from team tallies.
  const aggregate =
    total.Total ?? sumPeriods([total.H1, total.H2, total.ET1, total.ET2]);
  const stats: TeamStats =
    aggregate === null
      ? ZERO_TEAM_STATS
      : {
          goals: aggregate.Goals,
          yellowCards: aggregate.YellowCards,
          redCards: aggregate.RedCards,
          corners: aggregate.Corners,
        };
  const regulationGoals =
    total.H1 !== undefined && total.H2 !== undefined
      ? total.H1.Goals + total.H2.Goals
      : null;
  const sawExtraTimePeriods =
    total.ET1 !== undefined ||
    total.ET2 !== undefined ||
    total.ETTotal !== undefined ||
    total.PE !== undefined;
  return { stats, regulationGoals, sawExtraTimePeriods };
}

/**
 * Builds the domain ScoreState. During regulation every goal is a
 * regulation goal, so goals-90 mirrors the total; once the match is past 90'
 * (ET periods present or an ET/pens phase) goals-90 comes strictly from the
 * H1+H2 breakdown and is null when the feed does not provide it.
 */
export function buildScoreState(record: ScoresRecord, phase: GamePhase): ScoreState | null {
  if (record.scoreSoccer === undefined) return null;
  const p1 = aggregateParticipant(record.scoreSoccer.Participant1);
  const p2 = aggregateParticipant(record.scoreSoccer.Participant2);
  const pastRegulation =
    p1.sawExtraTimePeriods || p2.sawExtraTimePeriods || PAST_REGULATION_PHASES.has(phase);
  return {
    p1: p1.stats,
    p2: p2.stats,
    p1Goals90: pastRegulation ? p1.regulationGoals : p1.stats.goals,
    p2Goals90: pastRegulation ? p2.regulationGoals : p2.stats.goals,
  };
}

const EMPTY_SCORE_STATE: ScoreState = {
  p1: ZERO_TEAM_STATS,
  p2: ZERO_TEAM_STATS,
  p1Goals90: null,
  p2Goals90: null,
};

// ── detail helpers ────────────────────────────────────────────────────────

type GoalTypeDomain = NonNullable<NonNullable<MatchEvent['detail']>['goalType']>;

function mapGoalType(record: ScoresRecord): GoalTypeDomain | undefined {
  const data = record.dataSoccer;
  if (data === undefined) return undefined;
  const name = coerceEnumName(data.GoalType)?.toLowerCase().replace(/[^a-z]/g, '');
  if (name === 'owngoal') return 'own_goal';
  if (data.Penalty === true) return 'penalty';
  if (name === 'head') return 'head';
  if (name === 'shot') return 'shot';
  if (name !== null && name !== undefined) return 'other';
  return undefined;
}

function asParticipant(value: number | undefined): 1 | 2 | undefined {
  return value === 1 || value === 2 ? value : undefined;
}

function anyPossibleEventFlag(record: ScoresRecord): boolean {
  const neutral = record.possibleEventSoccer;
  if (neutral !== undefined && (neutral.RedCard === true || neutral.YellowCard === true || neutral.VAR === true)) {
    return true;
  }
  for (const state of [record.parti1StateSoccer, record.parti2StateSoccer]) {
    const possible = state?.PossibleEvent;
    if (possible !== undefined && (possible.Goal === true || possible.Penalty === true || possible.Corner === true)) {
      return true;
    }
  }
  return false;
}

/** A record whose SoccerData mentions VAR with the flag lowered = check resolved. */
function isVarEnd(record: ScoresRecord): boolean {
  const data = record.dataSoccer;
  if (data === undefined || data.VAR !== false) return false;
  const mentionsVar = (value: string | undefined): boolean =>
    value !== undefined && /(^|[^a-z])var([^a-z]|$)/i.test(value);
  return mentionsVar(data.Type) || mentionsVar(data.Action);
}

// ── kind classification ───────────────────────────────────────────────────

function classifyKind(
  record: ScoresRecord,
  actionClass: ActionClass,
  phaseChanged: boolean,
): MatchEventKind {
  const data = record.dataSoccer;
  if (actionClass === 'discard' && data?.Goal === true) return 'goal_discarded';
  if (actionClass === 'amend' && data?.Goal === true) return 'goal_amended';
  if (data?.VAR === true) return 'var_check';
  if (isVarEnd(record)) return 'var_end';
  if (data?.Goal === true) return 'goal';
  if (data?.RedCard === true || data?.YellowCard === true) return 'card';
  if (record.lineups !== undefined && record.lineups.length > 0) return 'lineup';
  if (anyPossibleEventFlag(record)) return 'possible_event';
  const statusName = coerceEnumName(record.statusSoccerId);
  if (statusName !== null && COVERAGE_LOST_STATUSES.has(statusName)) return 'coverage_warning';
  if (record.coverageSecondaryData === true) return 'coverage_warning';
  // Records carry the CURRENT status on every update, so only an actual
  // transition (or an explicit StatusId detail) counts as a phase change.
  if (phaseChanged || data?.StatusId !== undefined) return 'phase_change';
  if (record.stats !== undefined && Object.keys(record.stats).length > 0) return 'stat_update';
  return 'other';
}

// ── normalizeScores ───────────────────────────────────────────────────────

export interface NormalizeScoresOptions {
  /**
   * Persistent map of TxLINE event `id` → last seq seen for it. Amend/discard
   * records share the original event's `id`, which is how `reversesSeq` is
   * resolved. LiveSource/ReplaySource keep this map across calls; without it
   * only same-batch reversals resolve. The map is mutated as a side effect.
   */
  seqByEventId?: Map<number, number>;
  /** Carries the last known phase per fixture for records without a status. Mutated. */
  lastPhaseByFixture?: Map<number, GamePhase>;
  /** Carries the last known score per fixture for records without scoreSoccer. Mutated. */
  lastScoreByFixture?: Map<number, ScoreState>;
  logger?: TxlineLogger;
}

/**
 * Normalizes a raw TxLINE scores payload — a single Scores record (SSE frame)
 * or an array of them (snapshot endpoint) — into domain MatchEvents, ordered
 * by seq. Unparseable records are logged and skipped, never thrown.
 *
 * Player names are deliberately NOT resolved here: only `playerNormativeId`
 * is carried and `playerName` stays null until lineup data binds it upstream.
 */
export function normalizeScores(
  payload: unknown,
  receivedAtMs: number,
  options: NormalizeScoresOptions = {},
): MatchEvent[] {
  const logger = options.logger ?? consoleLogger;
  const seqByEventId = options.seqByEventId ?? new Map<number, number>();
  const lastPhaseByFixture = options.lastPhaseByFixture ?? new Map<number, GamePhase>();
  const lastScoreByFixture = options.lastScoreByFixture ?? new Map<number, ScoreState>();

  const rawRecords: unknown[] = Array.isArray(payload) ? payload : [payload];
  const records: ScoresRecord[] = [];
  for (const raw of rawRecords) {
    const parsed = scoresRecordSchema.safeParse(raw);
    if (!parsed.success) {
      logger('skipping unparseable scores record', {
        issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      continue;
    }
    records.push(parsed.data);
  }
  records.sort((a, b) => a.seq - b.seq);

  const events: MatchEvent[] = [];
  for (const record of records) {
    const actionClass = classifyAction(record.action);

    const mappedPhase = mapSoccerStatusToGamePhase(record.statusSoccerId);
    if (record.statusSoccerId !== undefined && mappedPhase === null) {
      logger('unknown statusSoccerId', { statusSoccerId: record.statusSoccerId });
    }
    const previousPhase = lastPhaseByFixture.get(record.fixtureId);
    const phase: GamePhase =
      mappedPhase ?? previousPhase ?? phaseFromGameState(record.gameState) ?? 'NS';
    const phaseChanged =
      mappedPhase !== null && (previousPhase === undefined || mappedPhase !== previousPhase);
    lastPhaseByFixture.set(record.fixtureId, phase);

    const score =
      buildScoreState(record, phase) ?? lastScoreByFixture.get(record.fixtureId) ?? EMPTY_SCORE_STATE;
    lastScoreByFixture.set(record.fixtureId, score);

    const kind = classifyKind(record, actionClass, phaseChanged);

    let reversesSeq: number | undefined;
    if ((kind === 'goal_amended' || kind === 'goal_discarded') && record.id !== undefined) {
      reversesSeq = seqByEventId.get(record.id);
      if (reversesSeq === undefined) {
        logger('amend/discard without resolvable original seq', {
          fixtureId: record.fixtureId,
          seq: record.seq,
          eventId: record.id,
        });
      }
    }
    if (record.id !== undefined) seqByEventId.set(record.id, record.seq);

    const data = record.dataSoccer;
    const participant = asParticipant(data?.Participant ?? record.participant);
    const goalType = mapGoalType(record);
    const card: 'yellow' | 'red' | undefined =
      data?.RedCard === true ? 'red' : data?.YellowCard === true ? 'yellow' : undefined;
    const playerNormativeId = data?.PlayerId ?? null;

    const hasDetail =
      participant !== undefined ||
      playerNormativeId !== null ||
      goalType !== undefined ||
      card !== undefined ||
      reversesSeq !== undefined;

    const event: MatchEvent = {
      kind,
      fixtureId: record.fixtureId,
      seq: record.seq,
      tsMs: record.ts,
      receivedAtMs,
      // TxLINE only marks provisional records explicitly; absence ⇒ confirmed.
      confirmed: record.confirmed !== false,
      phase,
      minute: data?.Minutes ?? null,
      score,
      ...(hasDetail
        ? {
            detail: {
              ...(participant !== undefined ? { participant } : {}),
              playerNormativeId,
              // Name resolution is deferred to lineup binding upstream.
              playerName: null,
              ...(goalType !== undefined ? { goalType } : {}),
              ...(card !== undefined ? { card } : {}),
              ...(reversesSeq !== undefined ? { reversesSeq } : {}),
            },
          }
        : {}),
    };
    events.push(event);
  }
  return events;
}
