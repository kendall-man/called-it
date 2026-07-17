/**
 * Match-script model: a match is authored as a timeline of entries at offsets
 * RELATIVE TO KICKOFF (`atMs`, negative = pre-match). The materializer walks
 * the timeline in order, maintains running score/phase state, and emits
 * records in the exact PascalCase wire shape `@calledit/txline` parses.
 */

/** 1-based ordinal of the TxLINE SoccerFixtureStatus oneOf — the live wire encoding. */
export const WIRE_STATUS = {
  NS: 1,
  H1: 2,
  HT: 3,
  H2: 4,
  F: 5,
  WET: 6,
  ET1: 7,
  HTET: 8,
  ET2: 9,
  FET: 10,
  A: 15,
} as const;
export type WireStatusName = keyof typeof WIRE_STATUS;

export interface ScriptPlayer {
  /** Cross-feed player key; also seeded into the staging players table. */
  normativeId: number;
  name: string;
  starter: boolean;
}

export interface ScriptTeam {
  participantId: number;
  name: string;
  players: ScriptPlayer[];
}

export type TeamSide = 1 | 2;

interface TimelineBase {
  /**
   * MATCH-CLOCK ms from kickoff (58' goal ⇒ 58 * 60_000); negative = wall ms
   * before kickoff. The materializer inserts the half-time break into wall
   * time for entries past 45' — authors think in match minutes only.
   */
  atMs: number;
}

export interface PhaseEntry extends TimelineBase {
  kind: 'phase';
  status: WireStatusName;
}

export interface GoalEntry extends TimelineBase {
  kind: 'goal';
  team: TeamSide;
  /** normativeId of the scorer (must exist in the script's lineups). */
  playerId?: number;
  goalType?: 'Shot' | 'Head' | 'Penalty' | 'OwnGoal';
  /**
   * Names this goal so later entries can reverse it. Discards share the
   * original record-level Id — exactly how the real feed links them.
   */
  tag?: string;
}

/** VAR overturn: score is decremented and the original goal's Id is reused. */
export interface DiscardEntry extends TimelineBase {
  kind: 'discard';
  ofTag: string;
}

export interface VarCheckEntry extends TimelineBase {
  kind: 'var_check';
}

/** VAR resolved — goal stands (or accompanies a discard for the overturn). */
export interface VarEndEntry extends TimelineBase {
  kind: 'var_end';
}

export interface CardEntry extends TimelineBase {
  kind: 'card';
  team: TeamSide;
  card: 'yellow' | 'red';
  playerId?: number;
}

/** Crowd-roar flag (possible goal/penalty under review) — freezes markets. */
export interface PossibleEventEntry extends TimelineBase {
  kind: 'possible_event';
  team: TeamSide;
  /** Which possibility the feed flags; defaults to a possible goal. */
  flag?: 'goal' | 'penalty';
}

export interface LineupsEntry extends TimelineBase {
  kind: 'lineups';
}

export interface AdditionalTimeEntry extends TimelineBase {
  kind: 'additional_time';
  minutes: number;
}

/**
 * Inert confirmed record (Action 'comment', empty Data). Scripted after a
 * possible_event to resolve the doubt when the possibility evaporates —
 * the reducer unfreezes on the next confirmed event.
 */
export interface CommentEntry extends TimelineBase {
  kind: 'comment';
}

export interface OddsEntry extends TimelineBase {
  kind: 'odds';
  /** Demargined 1X2 percentages, e.g. { home: 41.2, draw: 27.3, away: 31.5 }. */
  oneX2?: { home: number; draw: number; away: number };
  /** Main totals line, e.g. { line: 2.5, overPct: 53.1, underPct: 46.9 }. */
  totals?: { line: number; overPct: number; underPct: number };
  /** Off-the-board marker (freezes markets via odds_suspension). */
  suspended?: boolean;
}

export type TimelineEntry =
  | PhaseEntry
  | GoalEntry
  | DiscardEntry
  | VarCheckEntry
  | VarEndEntry
  | CardEntry
  | PossibleEventEntry
  | LineupsEntry
  | AdditionalTimeEntry
  | CommentEntry
  | OddsEntry;

export interface MatchScript {
  /** Stable key used by /mock/schedule to pick a script. */
  key: string;
  competition: string;
  competitionId: number;
  home: ScriptTeam;
  away: ScriptTeam;
  timeline: TimelineEntry[];
}

/** A wire record paired with the wall-clock time it becomes visible. */
export interface Materialized<T> {
  wallTs: number;
  record: T;
}

/** Raw JSON-shaped records (schema-validated in tests, opaque at runtime). */
export type WireRecord = Record<string, unknown>;

export interface MaterializedMatch {
  fixtureId: number;
  script: MatchScript;
  kickoffWallMs: number;
  /** Wall-time compression: 10 ⇒ one scripted minute passes in 6 seconds. */
  timeScale: number;
  scheduledAtMs: number;
  fixture: WireRecord;
  scores: Array<Materialized<WireRecord>>;
  odds: Array<Materialized<WireRecord>>;
}
