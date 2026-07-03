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
  type SoccerEventDetail,
  type SoccerPeriodScore,
  type SoccerTotalScore,
} from './schemas.js';

// ── StatusId → GamePhase ──────────────────────────────────────────────────

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

/**
 * On the live wire StatusId is a bare NUMBER (observed: 4 on second-half
 * records at ~85–90' with an H2 period present and a running clock). The
 * values follow the 1-BASED ordinal of the spec's SoccerFixtureStatus oneOf
 * order below — the only indexing consistent with the observed pin (0-based
 * would make 4 = F, impossible while the clock runs). Only 4 is empirically
 * pinned; unknown numbers map to null so the previous phase is kept.
 */
const SOCCER_STATUS_ORDINALS = [
  'NS',
  'H1',
  'HT',
  'H2',
  'F',
  'WET',
  'ET1',
  'HTET',
  'ET2',
  'FET',
  'WPE',
  'PE',
  'FPE',
  'I',
  'A',
  'C',
  'P',
  'TXCC',
  'TXCS',
] as const;

function buildNumericStatusMap(): Record<number, GamePhase> {
  const map: Record<number, GamePhase> = {};
  SOCCER_STATUS_ORDINALS.forEach((name, index) => {
    const phase = SOCCER_STATUS_TO_PHASE[name];
    if (phase !== undefined) map[index + 1] = phase;
  });
  return map;
}

export const NUMERIC_SOCCER_STATUS_TO_PHASE: Readonly<Record<number, GamePhase>> =
  buildNumericStatusMap();

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
 * The spec encodes enum-ish values (StatusId, GoalType) as a oneOf of empty
 * named objects. Depending on the server serializer that arrives as a bare
 * string ("FET"), a single-key wrapper ({"FET":{}}), or a discriminator
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

/**
 * Maps a raw record-level `StatusId` value to a GamePhase; null when
 * unrecognized. Numbers (the live wire encoding) consult the ordinal map;
 * strings/wrappers (spec encodings) consult the name map.
 */
export function mapSoccerStatusToGamePhase(raw: unknown): GamePhase | null {
  if (typeof raw === 'number') return NUMERIC_SOCCER_STATUS_TO_PHASE[raw] ?? null;
  const name = coerceEnumName(raw);
  if (name === null) return null;
  return SOCCER_STATUS_TO_PHASE[name] ?? null;
}

/**
 * Unknown StatusId values are logged once per process: every live record
 * repeats the CURRENT status, so per-record logging would drown real
 * warnings during a match.
 */
const unknownStatusLogged = new Set<string>();

function logUnknownStatusOnce(statusId: unknown, logger: TxlineLogger): void {
  const key = typeof statusId === 'object' ? JSON.stringify(statusId) : String(statusId);
  if (unknownStatusLogged.has(key)) return;
  unknownStatusLogged.add(key);
  logger('unknown StatusId — keeping previous phase', { statusId });
}

/**
 * Last-resort phase inference from the free-form `GameState` string.
 * 'sched(uled)' is deliberately NOT mapped: live devnet keeps GameState at
 * the literal 'scheduled' for the entire match, so it proves nothing.
 */
function phaseFromGameState(gameState: string | undefined): GamePhase | null {
  if (gameState === undefined) return null;
  if (/pre|not.?started/i.test(gameState)) return 'NS';
  if (/finish|final|ended|complete|full.?time/i.test(gameState)) return 'F';
  if (/half.?time/i.test(gameState)) return 'HT';
  if (/live|running|play|progress/i.test(gameState)) return 'H1';
  return null;
}

const SCORE_PERIOD_KEYS = ['H1', 'HT', 'H2', 'ET1', 'ET2', 'PE', 'ETTotal', 'Total'] as const;

function anyNonZeroTally(total: SoccerTotalScore | undefined): boolean {
  if (total === undefined) return false;
  return SCORE_PERIOD_KEYS.some((key) => {
    const period = total[key];
    return (
      period !== undefined &&
      period.Goals + period.YellowCards + period.RedCards + period.Corners > 0
    );
  });
}

/**
 * Signals that PROVABLY reflect a match in progress, used to floor a
 * resolved 'NS' up to 'H1'. A zeroed score object is not evidence of kickoff
 * (pre-match records carry one too) — only a running clock or a non-zero
 * tally counts.
 */
function hasLivenessSignal(record: ScoresRecord): boolean {
  if (record.Clock?.Running === true) return true;
  const score = record.Score;
  if (score === undefined) return false;
  return anyNonZeroTally(score.Participant1) || anyNonZeroTally(score.Participant2);
}

// ── action classification ─────────────────────────────────────────────────

/**
 * `action` values inventoried from live devnet: comment, coverage_update,
 * action_amend, action_discarded, additional_time. Stems keep tense/casing
 * variants classifying; 'updat' is deliberately excluded — it false-matched
 * the routine 'coverage_update' notices as amendments.
 */
const AMEND_ACTION_PATTERN = /amend|correct|edit/i;
const DISCARD_ACTION_PATTERN = /discard|delet|cancel|remov|void/i;
/** Routine coverage notices (e.g. 'coverage_update') are never event edits. */
const COVERAGE_NOTICE_PATTERN = /^coverage/i;

type ActionClass = 'new' | 'amend' | 'discard';

function classifyAction(action: string): ActionClass {
  if (COVERAGE_NOTICE_PATTERN.test(action)) return 'new';
  if (DISCARD_ACTION_PATTERN.test(action)) return 'discard';
  if (AMEND_ACTION_PATTERN.test(action)) return 'amend';
  return 'new';
}

/**
 * `additional_time` records announce the STOPPAGE LENGTH in Data.Minutes
 * (e.g. 6 at the 90th minute) — never the match minute.
 */
const ADDITIONAL_TIME_ACTION_PATTERN = /additional.?time/i;

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
  if (record.Score === undefined) return null;
  const p1 = aggregateParticipant(record.Score.Participant1);
  const p2 = aggregateParticipant(record.Score.Participant2);
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

function mapGoalType(detail: SoccerEventDetail | undefined): GoalTypeDomain | undefined {
  if (detail === undefined) return undefined;
  const name = coerceEnumName(detail.GoalType)?.toLowerCase().replace(/[^a-z]/g, '');
  if (name === 'owngoal') return 'own_goal';
  if (detail.Penalty === true) return 'penalty';
  if (name === 'head') return 'head';
  if (name === 'shot') return 'shot';
  if (name !== null && name !== undefined) return 'other';
  return undefined;
}

function asParticipant(value: number | undefined): 1 | 2 | undefined {
  return value === 1 || value === 2 ? value : undefined;
}

function anyPossibleEventFlag(record: ScoresRecord): boolean {
  const neutral = record.PossibleEvent;
  if (neutral !== undefined && (neutral.RedCard === true || neutral.YellowCard === true || neutral.VAR === true)) {
    return true;
  }
  for (const state of [record.Parti1State, record.Parti2State]) {
    const possible = state?.PossibleEvent;
    if (possible !== undefined && (possible.Goal === true || possible.Penalty === true || possible.Corner === true)) {
      return true;
    }
  }
  return false;
}

/** A record whose SoccerData mentions VAR with the flag lowered = check resolved. */
function isVarEnd(record: ScoresRecord): boolean {
  const data = record.Data;
  if (data === undefined || data.VAR !== false) return false;
  const mentionsVar = (value: string | undefined): boolean =>
    value !== undefined && /(^|[^a-z])var([^a-z]|$)/i.test(value);
  return mentionsVar(data.Type) || mentionsVar(data.Action);
}

// ── kind classification ───────────────────────────────────────────────────

/** The goal family an amend/discard can reverse (an amended goal is still a goal). */
const GOAL_FAMILY_KINDS: ReadonlySet<MatchEventKind> = new Set([
  'goal',
  'goal_amended',
  'goal_discarded',
]);

function classifyKind(
  record: ScoresRecord,
  actionClass: ActionClass,
  phaseChanged: boolean,
  mappedPhase: GamePhase | null,
  originalKind: MatchEventKind | undefined,
): MatchEventKind {
  const data = record.Data;
  if (actionClass === 'discard' || actionClass === 'amend') {
    // Amend/discard envelopes rarely restate the event they touch (observed
    // live: action_discarded with Data: {}). Whether a GOAL is being
    // reversed comes first from what the original event (same Id) was, with
    // the envelope's Goal flags — top-level or under New/Previous — as
    // fallback for originals we never saw.
    const touchesGoal =
      (originalKind !== undefined && GOAL_FAMILY_KINDS.has(originalKind)) ||
      data?.Goal === true ||
      data?.New?.Goal === true ||
      data?.Previous?.Goal === true;
    if (touchesGoal) return actionClass === 'discard' ? 'goal_discarded' : 'goal_amended';
  }
  if (data?.VAR === true) return 'var_check';
  if (isVarEnd(record)) return 'var_end';
  if (data?.Goal === true) return 'goal';
  if (data?.RedCard === true || data?.YellowCard === true) return 'card';
  if (record.Lineups !== undefined && record.Lineups.length > 0) return 'lineup';
  if (anyPossibleEventFlag(record)) return 'possible_event';
  // Coverage loss comes from the TXCC/TXCS statuses (numeric or named) via
  // the phase map. CoverageSecondaryData is deliberately NOT a warning: it is
  // a static "covered from TV/Stream/Venue" fixture attribute present on
  // every record of covered fixtures.
  if (mappedPhase === 'COV_LOST') return 'coverage_warning';
  // Records carry the CURRENT status on every update, so only an actual
  // transition (or an explicit StatusId in the Data detail) counts as a phase change.
  if (phaseChanged || data?.StatusId !== undefined) return 'phase_change';
  if (record.Stats !== undefined && Object.keys(record.Stats).length > 0) return 'stat_update';
  return 'other';
}

// ── normalizeScores ───────────────────────────────────────────────────────

/**
 * TxLINE event `Id`s are PER-FIXTURE counters (every fixture restarts at
 * 0, 1, …), so event-keyed maps must be fixture-scoped or concurrent matches
 * corrupt each other's reversal bookkeeping.
 */
const eventKeyOf = (fixtureId: number, eventId: number): string => `${fixtureId}:${eventId}`;

/**
 * Process-wide fallback registry of the kind emitted per composite event key.
 * Amend/discard records often carry an EMPTY Data envelope, so whether they
 * reverse a goal is only knowable from what the original event was. Callers
 * that predate the `kindByEventId` option (LiveSource/ReplaySource pass only
 * seq maps) still get cross-frame reversal resolution through this registry;
 * composite keys make it safe to share across sources. Entries are one small
 * string per feed event — bounded by match length, no eviction needed.
 */
const processKindByEventId = new Map<string, MatchEventKind>();

export interface NormalizeScoresOptions {
  /**
   * Persistent map of composite `${fixtureId}:${eventId}` → last seq seen for
   * that event. Amend/discard records share the original event's `Id`, which
   * is how `reversesSeq` is resolved. LiveSource/ReplaySource keep this map
   * across calls; without it only same-batch reversals resolve. The map is
   * mutated as a side effect. (Typed to also accept the number-keyed maps
   * callers historically constructed; keys are always written as composite
   * strings.)
   */
  seqByEventId?: Map<string | number, number>;
  /**
   * Kind previously emitted per composite `${fixtureId}:${eventId}` — lets an
   * empty-Data amend/discard resolve whether it reverses a goal. Mutated.
   * Defaults to a process-wide registry so reversals resolve across calls
   * even for callers that do not pass one.
   */
  kindByEventId?: Map<string, MatchEventKind>;
  /** Carries the last known phase per fixture for records without a status. Mutated. */
  lastPhaseByFixture?: Map<number, GamePhase>;
  /** Carries the last known score per fixture for records without a Score. Mutated. */
  lastScoreByFixture?: Map<number, ScoreState>;
  logger?: TxlineLogger;
}

const SECONDS_PER_MINUTE = 60;

/** Football display convention: seconds 0–59 are the 1st minute (5403s → 91'). */
function minuteFromClockSeconds(seconds: number): number {
  return Math.floor(seconds / SECONDS_PER_MINUTE) + 1;
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
  const seqByEventId: Map<string | number, number> = options.seqByEventId ?? new Map();
  const kindByEventId = options.kindByEventId ?? processKindByEventId;
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
  records.sort((a, b) => a.Seq - b.Seq);

  const events: MatchEvent[] = [];
  for (const record of records) {
    const actionClass = classifyAction(record.Action);

    const mappedPhase = mapSoccerStatusToGamePhase(record.StatusId);
    if (record.StatusId !== undefined && record.StatusId !== null && mappedPhase === null) {
      logUnknownStatusOnce(record.StatusId, logger);
    }
    const previousPhase = lastPhaseByFixture.get(record.FixtureId);
    // GameState lies mid-match (live records carry the literal 'scheduled'),
    // so it is only consulted last — and a provable liveness signal upgrades
    // a fallback 'NS' to in-play.
    let phase: GamePhase =
      mappedPhase ?? previousPhase ?? phaseFromGameState(record.GameState) ?? 'NS';
    if (phase === 'NS' && hasLivenessSignal(record)) phase = 'H1';
    const phaseChanged = mappedPhase !== null && mappedPhase !== previousPhase;
    lastPhaseByFixture.set(record.FixtureId, phase);

    const score =
      buildScoreState(record, phase) ?? lastScoreByFixture.get(record.FixtureId) ?? EMPTY_SCORE_STATE;
    lastScoreByFixture.set(record.FixtureId, score);

    const eventKey = record.Id !== undefined ? eventKeyOf(record.FixtureId, record.Id) : null;
    const originalKind = eventKey === null ? undefined : kindByEventId.get(eventKey);
    const kind = classifyKind(record, actionClass, phaseChanged, mappedPhase, originalKind);

    let reversesSeq: number | undefined;
    if ((kind === 'goal_amended' || kind === 'goal_discarded') && eventKey !== null) {
      reversesSeq = seqByEventId.get(eventKey);
      if (reversesSeq === undefined) {
        logger('amend/discard without resolvable original seq', {
          fixtureId: record.FixtureId,
          seq: record.Seq,
          eventId: record.Id,
        });
      }
    }
    if (eventKey !== null) {
      seqByEventId.set(eventKey, record.Seq);
      kindByEventId.set(eventKey, kind);
    }

    const data = record.Data;
    // Amends carry the corrected payload under Data.New — prefer it for detail.
    const detailData: SoccerEventDetail | undefined = data?.New ?? data;
    const participant = asParticipant(detailData?.Participant);
    const goalType = mapGoalType(detailData);
    const card: 'yellow' | 'red' | undefined =
      detailData?.RedCard === true ? 'red' : detailData?.YellowCard === true ? 'yellow' : undefined;
    const playerNormativeId = detailData?.PlayerId ?? null;

    const clockSeconds = record.Clock?.Seconds;
    const isAdditionalTime = ADDITIONAL_TIME_ACTION_PATTERN.test(record.Action);
    const minute =
      clockSeconds !== undefined
        ? minuteFromClockSeconds(clockSeconds)
        : // additional_time's Data.Minutes is the announced stoppage length
          // (e.g. 6 at the 90th minute), never the match minute.
          isAdditionalTime
          ? null
          : detailData?.Minutes ?? null;

    // The wire marks confirmation AFFIRMATIVELY (observed live: explicit
    // Confirmed: true; no Confirmed: false anywhere), so a goal must present
    // Confirmed === true before markets may settle on it. Corrective and
    // administrative records (amends, discards, phase/stat updates) are
    // routinely sent WITHOUT the flag — for those absence still means
    // confirmed: blocking a VAR rollback on a missing flag is the unsafe
    // direction.
    const confirmed = kind === 'goal' ? record.Confirmed === true : record.Confirmed !== false;

    const hasDetail =
      participant !== undefined ||
      playerNormativeId !== null ||
      goalType !== undefined ||
      card !== undefined ||
      reversesSeq !== undefined;

    const event: MatchEvent = {
      kind,
      fixtureId: record.FixtureId,
      seq: record.Seq,
      tsMs: record.Ts,
      receivedAtMs,
      confirmed,
      phase,
      minute,
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
