import { describe, expect, it, vi } from 'vitest';
import type { GamePhase, MatchEventKind, ScoreState } from '@calledit/market-engine';
import {
  buildScoreState,
  coerceEnumName,
  mapSoccerStatusToGamePhase,
  normalizeScores,
} from './normalize-scores.js';
import { silentLogger } from './logging.js';
import { scoresRecordSchema } from './schemas.js';
import { FIXTURE_ID, KICKOFF_MS, period, scoreSoccer, scoresRecord } from './test-fixtures.js';

const RECEIVED_AT_MS = KICKOFF_MS + 61_000;

const normalize = (payload: unknown, options = {}) =>
  normalizeScores(payload, RECEIVED_AT_MS, { logger: silentLogger, ...options });

/** Fresh reversal-bookkeeping maps, isolated from the process-wide registry. */
const freshEventMaps = () => ({
  seqByEventId: new Map<string | number, number>(),
  kindByEventId: new Map<string, MatchEventKind>(),
});

describe('StatusId → GamePhase mapping', () => {
  const table: Array<[unknown, GamePhase | null]> = [
    ['NS', 'NS'],
    ['H1', 'H1'],
    ['HT', 'HT'],
    ['H2', 'H2'],
    ['F', 'F'],
    ['WET', 'HTET'], // waiting for extra time — regulation over, nothing terminal
    ['ET1', 'ET1'],
    ['HTET', 'HTET'],
    ['ET2', 'ET2'],
    ['FET', 'FET'],
    ['WPE', 'PE'], // waiting for penalties — FET would be wrongly terminal
    ['PE', 'PE'],
    ['FPE', 'FPE'],
    ['I', 'INT'],
    ['A', 'ABD'],
    ['C', 'CAN'],
    ['P', 'POST'],
    ['TXCC', 'COV_LOST'],
    ['TXCS', 'COV_LOST'],
    // numeric wire encoding: 1-based ordinal of the status oneOf
    [1, 'NS'],
    [2, 'H1'],
    [3, 'HT'],
    [4, 'H2'], // the empirically pinned value (live second-half records)
    [5, 'F'],
    [6, 'HTET'], // WET
    [10, 'FET'],
    [18, 'COV_LOST'], // TXCC
    [19, 'COV_LOST'], // TXCS
    // wrapper encodings of the oneOf-of-empty-objects spec shape
    [{ F: {} }, 'F'],
    [{ type: 'ET1' }, 'ET1'],
    // unknowns
    ['ZZZ', null],
    [42, null],
    [0, null], // ordinals are 1-based; 0 is unknown
    [undefined, null],
  ];

  it.each(table)('maps %j to %j', (raw, expected) => {
    expect(mapSoccerStatusToGamePhase(raw)).toBe(expected);
  });

  it('coerces enum names from all wire encodings', () => {
    expect(coerceEnumName('FET')).toBe('FET');
    expect(coerceEnumName({ FET: {} })).toBe('FET');
    expect(coerceEnumName({ type: 'FET' })).toBe('FET');
    expect(coerceEnumName({ a: 1, b: 2 })).toBeNull();
    expect(coerceEnumName(null)).toBeNull();
  });

  it('keeps the previous phase and logs once for an unknown numeric StatusId', () => {
    const logger = vi.fn();
    const lastPhaseByFixture = new Map<number, GamePhase>([[FIXTURE_ID, 'H2']]);
    const [event] = normalizeScores(
      scoresRecord({ statusSoccerId: 777_777 }),
      RECEIVED_AT_MS,
      { logger, lastPhaseByFixture },
    );
    expect(event?.phase).toBe('H2');
    expect(logger).toHaveBeenCalledWith(
      'unknown StatusId — keeping previous phase',
      expect.objectContaining({ statusId: 777_777 }),
    );
  });
});

describe('wire-shape parsing (PascalCase reality vs camelCase spec)', () => {
  it('parses a full PascalCase wire record (dump-shaped, synthetic values)', () => {
    // Shape mirrors the live /api/scores/snapshot records; every value invented.
    const wireRecord = {
      FixtureId: 55_001_234,
      GameState: 'scheduled', // the wire keeps this literal mid-match
      StartTime: KICKOFF_MS,
      IsTeam: true,
      FixtureGroupId: 88,
      CompetitionId: 9,
      CountryId: 77,
      SportId: 1,
      Participant1IsHome: true,
      Participant2Id: 4321,
      Participant1Id: 1234,
      CoverageSecondaryData: true,
      CoverageType: 'TV/Stream',
      Action: 'comment',
      Id: 12,
      Ts: KICKOFF_MS + 85 * 60_000,
      ConnectionId: 7,
      Seq: 500,
      StatusId: 4,
      Type: 'Soccer',
      Clock: { Running: true, Seconds: 5_100 },
      Score: {
        Participant1: {
          H1: { Goals: 1, Corners: 2 }, // sparse: zero tallies omitted
          H2: { Goals: 1, Corners: 2 },
          Total: { Goals: 2, Corners: 4 },
        },
        Participant2: {
          H1: { YellowCards: 1, Corners: 1 },
          H2: { YellowCards: 1, Corners: 1 },
          Total: { YellowCards: 2, Corners: 2 },
        },
      },
      Data: {},
      Stats: { '1': 2, '7': 4 },
      Participant: 1,
      Possession: 1,
      PossessionType: 'SafePossession',
    };
    const [event] = normalize(wireRecord);
    expect(event).toBeDefined();
    expect(event?.fixtureId).toBe(55_001_234);
    expect(event?.seq).toBe(500);
    expect(event?.phase).toBe('H2'); // numeric StatusId 4, NOT GameState 'scheduled'
    expect(event?.minute).toBe(86);
    expect(event?.score.p1.goals).toBe(2);
    expect(event?.score.p1.corners).toBe(4);
    expect(event?.score.p2.yellowCards).toBe(2);
    expect(event?.score.p1Goals90).toBe(2);
    // Sparse fields defaulted, never NaN.
    expect(Number.isNaN(event?.score.p2.goals)).toBe(false);
    expect(event?.score.p2.goals).toBe(0);
  });

  it('still accepts a spec-shaped camelCase record (alias fold)', () => {
    const specRecord = {
      fixtureId: 66_005_678,
      seq: 3,
      ts: KICKOFF_MS + 60_000,
      action: 'Insert',
      id: 9,
      gameState: 'InPlay',
      statusSoccerId: 'H1',
      confirmed: true,
      dataSoccer: { Goal: true, Participant: 2, PlayerId: 42 },
      scoreSoccer: scoreSoccer({ Total: period(0) }, { Total: period(1) }),
    };
    const [event] = normalize(specRecord);
    expect(event?.kind).toBe('goal');
    expect(event?.fixtureId).toBe(66_005_678);
    expect(event?.phase).toBe('H1');
    expect(event?.score.p2.goals).toBe(1);
  });

  it('mirrors seq/ts/startTime in camelCase on the parsed record', () => {
    const record = scoresRecordSchema.parse(scoresRecord({ seq: 44 }));
    expect(record.Seq).toBe(44);
    expect(record.seq).toBe(44);
    expect(record.ts).toBe(record.Ts);
    expect(record.startTime).toBe(record.StartTime);
  });

  it('does not treat a record with a sparse Score as unparseable', () => {
    const logger = vi.fn();
    const events = normalizeScores(
      scoresRecord({
        scoreSoccer: {
          Participant1: { H1: { Goals: 1 } }, // no cards, no corners, no Total
          Participant2: {},
        },
      }),
      RECEIVED_AT_MS,
      { logger },
    );
    expect(events).toHaveLength(1);
    expect(logger).not.toHaveBeenCalledWith('skipping unparseable scores record', expect.anything());
    expect(events[0]?.score.p1.goals).toBe(1);
    expect(events[0]?.score.p1.yellowCards).toBe(0);
  });

  it('survives a one-sided Score object', () => {
    const [event] = normalize(
      scoresRecord({ scoreSoccer: { Participant1: { Total: period(2) } } }),
    );
    expect(event?.score.p1.goals).toBe(2);
    expect(event?.score.p2.goals).toBe(0);
  });
});

describe('normalizeScores — goals', () => {
  it('normalizes a confirmed goal with player and score', () => {
    const [event] = normalize(
      scoresRecord({
        seq: 7,
        ts: KICKOFF_MS + 23 * 60_000,
        dataSoccer: { Goal: true, Participant: 1, PlayerId: 777, GoalType: 'Shot', Minutes: 23 },
        scoreSoccer: scoreSoccer({ Total: period(1) }, { Total: period(0) }),
      }),
    );
    expect(event).toBeDefined();
    expect(event?.kind).toBe('goal');
    expect(event?.fixtureId).toBe(FIXTURE_ID);
    expect(event?.seq).toBe(7);
    expect(event?.tsMs).toBe(KICKOFF_MS + 23 * 60_000);
    expect(event?.receivedAtMs).toBe(RECEIVED_AT_MS);
    expect(event?.confirmed).toBe(true);
    expect(event?.phase).toBe('H1');
    expect(event?.minute).toBe(23);
    expect(event?.score.p1.goals).toBe(1);
    expect(event?.score.p1Goals90).toBe(1);
    expect(event?.detail?.participant).toBe(1);
    expect(event?.detail?.playerNormativeId).toBe(777);
    // Name resolution is deferred — only the id is carried.
    expect(event?.detail?.playerName).toBeNull();
    expect(event?.detail?.goalType).toBe('shot');
  });

  it('maps own goals (wrapper-encoded GoalType) with precedence over penalty', () => {
    const [event] = normalize(
      scoresRecord({
        dataSoccer: { Goal: true, Participant: 2, GoalType: { OwnGoal: {} }, Penalty: true },
      }),
    );
    expect(event?.detail?.goalType).toBe('own_goal');
  });

  it('maps penalty goals from the Penalty flag', () => {
    const [event] = normalize(
      scoresRecord({ dataSoccer: { Goal: true, Participant: 1, GoalType: 'Shot', Penalty: true } }),
    );
    expect(event?.detail?.goalType).toBe('penalty');
  });

  it('derives the minute from the running clock when present', () => {
    const [event] = normalize(
      scoresRecord({
        dataSoccer: { Goal: true, Participant: 1 },
        Clock: { Running: true, Seconds: 1_350 }, // 22:30 → 23rd minute
      }),
    );
    expect(event?.minute).toBe(23);
  });
});

describe('normalizeScores — confirmation semantics', () => {
  it('treats a goal WITHOUT an explicit Confirmed flag as unconfirmed', () => {
    // The wire confirms affirmatively; a flag-less goal is a provisional flash.
    const [event] = normalize(scoresRecord({ confirmed: undefined, dataSoccer: { Goal: true } }));
    expect(event?.kind).toBe('goal');
    expect(event?.confirmed).toBe(false);
  });

  it('confirms a goal only on explicit Confirmed: true', () => {
    const [event] = normalize(scoresRecord({ confirmed: true, dataSoccer: { Goal: true } }));
    expect(event?.confirmed).toBe(true);
  });

  it('keeps absence ⇒ confirmed for non-goal records, explicit false ⇒ unconfirmed', () => {
    const [administrative] = normalize(
      scoresRecord({ confirmed: undefined, dataSoccer: { YellowCard: true } }),
    );
    const [denied] = normalize(scoresRecord({ confirmed: false, dataSoccer: { YellowCard: true } }));
    expect(administrative?.confirmed).toBe(true);
    expect(denied?.confirmed).toBe(false);
  });
});

describe('normalizeScores — VAR, amend, discard', () => {
  it('classifies a raised VAR flag as var_check', () => {
    const [event] = normalize(scoresRecord({ dataSoccer: { VAR: true, Type: 'Goal' } }));
    expect(event?.kind).toBe('var_check');
  });

  it('classifies a lowered VAR flag on a VAR-typed record as var_end', () => {
    const [event] = normalize(scoresRecord({ dataSoccer: { VAR: false, Type: 'VAR' } }));
    expect(event?.kind).toBe('var_end');
  });

  it('does not classify an ordinary goal with VAR:false as var_end', () => {
    const [event] = normalize(scoresRecord({ dataSoccer: { Goal: true, VAR: false, Type: 'Goal' } }));
    expect(event?.kind).toBe('goal');
  });

  it('resolves reversesSeq for an amend in the same batch via the event id', () => {
    const events = normalize(
      [
        scoresRecord({ seq: 10, id: 900, dataSoccer: { Goal: true, Participant: 1, PlayerId: 1 } }),
        scoresRecord({
          seq: 12,
          id: 900,
          action: 'action_amend',
          dataSoccer: { Goal: true, Participant: 1, PlayerId: 2 },
        }),
      ],
      freshEventMaps(),
    );
    expect(events.map((e) => e.kind)).toEqual(['goal', 'goal_amended']);
    expect(events[1]?.detail?.reversesSeq).toBe(10);
  });

  it('resolves reversesSeq across calls through shared maps', () => {
    const maps = freshEventMaps();
    normalize(scoresRecord({ seq: 10, id: 910, dataSoccer: { Goal: true } }), maps);
    const [discarded] = normalize(
      scoresRecord({ seq: 13, id: 910, action: 'action_discarded', dataSoccer: { Goal: true } }),
      maps,
    );
    expect(discarded?.kind).toBe('goal_discarded');
    expect(discarded?.detail?.reversesSeq).toBe(10);
  });

  it('classifies a goal discard from an EMPTY Data envelope via the original event kind', () => {
    // Observed live: action_discarded records carry Data: {} — the only link
    // to the discarded event is the record-level Id.
    const maps = freshEventMaps();
    normalize(scoresRecord({ seq: 50, id: 846, dataSoccer: { Goal: true, Participant: 1 } }), maps);
    const [discarded] = normalize(
      scoresRecord({ seq: 60, id: 846, action: 'action_discarded', dataSoccer: {} }),
      maps,
    );
    expect(discarded?.kind).toBe('goal_discarded');
    expect(discarded?.detail?.reversesSeq).toBe(50);
  });

  it('does NOT turn a non-goal amend (New/Previous envelope) into goal_amended', () => {
    // Shape of the live injury amend: payload only under Data.New/.Previous.
    const maps = freshEventMaps();
    const [event] = normalize(
      scoresRecord({
        seq: 930,
        id: 555,
        action: 'action_amend',
        dataSoccer: {
          Action: 'injury',
          New: { Clock: { Running: true, Seconds: 5_064 }, Outcome: 'OffPitch', PlayerId: 501_026 },
          Previous: { Clock: { Running: true, Seconds: 5_064 }, PlayerId: 501_026 },
        },
      }),
      maps,
    );
    expect(event?.kind).not.toBe('goal_amended');
    expect(event?.detail?.reversesSeq).toBeUndefined();
    // Detail is read from the corrected payload under New.
    expect(event?.detail?.playerNormativeId).toBe(501_026);
  });

  it('classifies goal_amended when the envelope flags a goal under New', () => {
    const [event] = normalize(
      scoresRecord({
        seq: 70,
        id: 600,
        action: 'action_amend',
        dataSoccer: { New: { Goal: true, Participant: 2, PlayerId: 9 }, Previous: { Goal: true } },
      }),
      freshEventMaps(),
    );
    expect(event?.kind).toBe('goal_amended');
    expect(event?.detail?.participant).toBe(2);
    expect(event?.detail?.playerNormativeId).toBe(9);
  });

  it('chains amendments: a second amend reverses the first amend', () => {
    const events = normalize(
      [
        scoresRecord({ seq: 5, id: 77, dataSoccer: { Goal: true } }),
        scoresRecord({ seq: 9, id: 77, action: 'action_amend', dataSoccer: {} }),
        scoresRecord({ seq: 12, id: 77, action: 'action_amend', dataSoccer: {} }),
      ],
      freshEventMaps(),
    );
    expect(events.map((e) => e.kind)).toEqual(['goal', 'goal_amended', 'goal_amended']);
    expect(events[2]?.detail?.reversesSeq).toBe(9);
  });

  it('logs when an amend cannot resolve its original event', () => {
    const logger = vi.fn();
    const [event] = normalizeScores(
      scoresRecord({ seq: 13, id: 901, action: 'action_amend', dataSoccer: { Goal: true } }),
      RECEIVED_AT_MS,
      { logger, ...freshEventMaps() },
    );
    expect(event?.kind).toBe('goal_amended');
    expect(event?.detail?.reversesSeq).toBeUndefined();
    expect(logger).toHaveBeenCalledWith(
      'amend/discard without resolvable original seq',
      expect.objectContaining({ eventId: 901 }),
    );
  });

  it('never resolves reversesSeq across fixtures (event ids are per-fixture counters)', () => {
    const maps = freshEventMaps();
    normalize(scoresRecord({ fixtureId: 111_222, seq: 10, id: 7, dataSoccer: { Goal: true } }), maps);
    const [foreignDiscard] = normalize(
      scoresRecord({
        fixtureId: 333_444,
        seq: 4,
        id: 7,
        action: 'action_discarded',
        dataSoccer: { Goal: true },
      }),
      maps,
    );
    const [homeDiscard] = normalize(
      scoresRecord({ fixtureId: 111_222, seq: 15, id: 7, action: 'action_discarded', dataSoccer: {} }),
      maps,
    );
    expect(foreignDiscard?.detail?.reversesSeq).toBeUndefined();
    expect(homeDiscard?.detail?.reversesSeq).toBe(10);
  });

  it('does not treat coverage_update as an amendment of the event sharing its id', () => {
    const maps = freshEventMaps();
    normalize(scoresRecord({ seq: 20, id: 0, dataSoccer: { Goal: true } }), maps);
    const [notice] = normalize(
      scoresRecord({ seq: 21, id: 0, action: 'coverage_update', dataSoccer: {} }),
      maps,
    );
    expect(notice?.kind).not.toBe('goal_amended');
    expect(notice?.detail?.reversesSeq).toBeUndefined();
  });
});

describe('normalizeScores — cards, lineups, possible events, coverage', () => {
  it('classifies yellow and red cards', () => {
    const [yellow] = normalize(
      scoresRecord({ dataSoccer: { YellowCard: true, Participant: 2, PlayerId: 88, Minutes: 40 } }),
    );
    const [red] = normalize(scoresRecord({ dataSoccer: { RedCard: true, Participant: 1 } }));
    expect(yellow?.kind).toBe('card');
    expect(yellow?.detail?.card).toBe('yellow');
    expect(yellow?.detail?.playerNormativeId).toBe(88);
    expect(red?.detail?.card).toBe('red');
  });

  it('classifies lineup records (spec camelCase entries)', () => {
    const [event] = normalize(
      scoresRecord({
        statusSoccerId: 'NS',
        lineups: [
          {
            id: 'team-1',
            normativeId: 111,
            preferredName: 'Alpha FC',
            gender: 'M',
            updateDateMillis: KICKOFF_MS - 3_600_000,
            lineups: [
              {
                fixturePlayerId: 1,
                statusId: 1,
                positionId: 4,
                unitId: 2,
                rosterNumber: '9',
                starter: true,
                starred: false,
                player: {
                  id: 'p-777',
                  normativeId: 777,
                  country: 'XX',
                  team: 'Alpha FC',
                  dateOfBirth: '2000-01-01',
                  gender: 'M',
                  preferredName: 'Test Niner',
                  updateDateMillis: KICKOFF_MS - 3_600_000,
                },
              },
            ],
          },
        ],
      }),
    );
    expect(event?.kind).toBe('lineup');
  });

  it('classifies lineup records with PascalCase wire keys', () => {
    const [event] = normalize(
      scoresRecord({
        statusSoccerId: 1,
        Lineups: [
          {
            NormativeId: 222,
            PreferredName: 'Beta United',
            Lineups: [
              { Starter: true, Player: { NormativeId: 888, PreferredName: 'Test Eighter' } },
            ],
          },
        ],
      }),
    );
    expect(event?.kind).toBe('lineup');
  });

  it('skips a malformed player entry without dropping the lineup or the record', () => {
    const record = scoresRecordSchema.parse(
      scoresRecord({
        lineups: [
          {
            normativeId: 111,
            preferredName: 'Alpha FC',
            lineups: [
              { starter: true, player: { normativeId: 777, preferredName: 'Test Niner' } },
              { starter: false, player: { preferredName: 'Anonymous Sub' } }, // no normativeId
              { starter: false }, // no player at all
            ],
          },
        ],
      }),
    );
    expect(record.Lineups).toHaveLength(1);
    expect(record.Lineups?.[0]?.lineups).toHaveLength(1);
    expect(record.Lineups?.[0]?.lineups?.[0]?.player.normativeId).toBe(777);
    const [event] = normalize(scoresRecord({ lineups: record.Lineups }));
    expect(event?.kind).toBe('lineup');
  });

  it('keeps the record (and its goal) when every lineup entry is malformed', () => {
    const [event] = normalize(
      scoresRecord({
        dataSoccer: { Goal: true, Participant: 1 },
        lineups: [{ mangled: true }],
      }),
    );
    expect(event).toBeDefined();
    expect(event?.kind).toBe('goal');
  });

  it('classifies possible-event flags (freeze trigger)', () => {
    const [event] = normalize(
      scoresRecord({
        parti1StateSoccer: { PossibleEvent: { Goal: true, Penalty: false, Corner: false } },
      }),
    );
    expect(event?.kind).toBe('possible_event');
  });

  it('classifies coverage-lost statuses as coverage_warning with COV_LOST phase', () => {
    const [named] = normalize(scoresRecord({ statusSoccerId: 'TXCS' }));
    const [numeric] = normalize(scoresRecord({ statusSoccerId: 19 }));
    expect(named?.kind).toBe('coverage_warning');
    expect(named?.phase).toBe('COV_LOST');
    expect(numeric?.kind).toBe('coverage_warning');
    expect(numeric?.phase).toBe('COV_LOST');
  });

  it('does NOT flag CoverageSecondaryData fixtures as coverage warnings', () => {
    // CoverageSecondaryData is a static "covered via TV/Stream/Venue"
    // attribute on every record of covered fixtures — not a loss of coverage.
    const [comment] = normalize(
      scoresRecord({
        action: 'comment',
        statusSoccerId: undefined,
        CoverageSecondaryData: true,
        CoverageType: 'Venue',
      }),
    );
    const [goal] = normalize(
      scoresRecord({ CoverageSecondaryData: true, dataSoccer: { Goal: true } }),
    );
    expect(comment?.kind).not.toBe('coverage_warning');
    expect(goal?.kind).toBe('goal');
  });
});

describe('normalizeScores — phase and score bookkeeping', () => {
  it('emits phase_change only on actual transitions (numeric statuses)', () => {
    const lastPhaseByFixture = new Map<number, GamePhase>();
    const [first] = normalize(scoresRecord({ seq: 1, statusSoccerId: 2 }), { lastPhaseByFixture });
    const [repeat] = normalize(scoresRecord({ seq: 2, statusSoccerId: 2 }), { lastPhaseByFixture });
    const [transition] = normalize(scoresRecord({ seq: 3, statusSoccerId: 3 }), {
      lastPhaseByFixture,
    });
    expect(first?.kind).toBe('phase_change');
    expect(repeat?.kind).not.toBe('phase_change');
    expect(transition?.kind).toBe('phase_change');
    expect(transition?.phase).toBe('HT');
  });

  it('carries the last known phase forward when a record has no status', () => {
    const lastPhaseByFixture = new Map<number, GamePhase>([[FIXTURE_ID, 'H2']]);
    const [event] = normalize(scoresRecord({ statusSoccerId: undefined }), { lastPhaseByFixture });
    expect(event?.phase).toBe('H2');
  });

  it('falls back to gameState heuristics when nothing else is known', () => {
    const [live] = normalize(scoresRecord({ statusSoccerId: undefined, gameState: 'InPlay' }));
    const [pre] = normalize(scoresRecord({ statusSoccerId: undefined, gameState: 'PreMatch' }));
    expect(live?.phase).toBe('H1');
    expect(pre?.phase).toBe('NS');
  });

  it("never maps the wire's static 'scheduled' GameState to NS on a live record", () => {
    // GameState stays 'scheduled' during live play; a running clock (or a
    // non-zero tally) must floor the phase to in-play.
    const [running] = normalize(
      scoresRecord({
        statusSoccerId: undefined,
        gameState: 'scheduled',
        Clock: { Running: true, Seconds: 310 },
      }),
    );
    const [scored] = normalize(
      scoresRecord({
        statusSoccerId: undefined,
        gameState: 'scheduled',
        scoreSoccer: scoreSoccer({ Total: period(1) }, { Total: period(0) }),
      }),
    );
    expect(running?.phase).toBe('H1');
    expect(scored?.phase).toBe('H1');
  });

  it('keeps NS for a genuinely pre-match record (zeroed score, no clock)', () => {
    const [event] = normalize(scoresRecord({ statusSoccerId: undefined, gameState: 'scheduled' }));
    expect(event?.phase).toBe('NS');
  });

  it('carries the last known score forward when Score is missing', () => {
    const carried: ScoreState = {
      p1: { goals: 2, yellowCards: 1, redCards: 0, corners: 3 },
      p2: { goals: 1, yellowCards: 0, redCards: 0, corners: 5 },
      p1Goals90: 2,
      p2Goals90: 1,
    };
    const lastScoreByFixture = new Map<number, ScoreState>([[FIXTURE_ID, carried]]);
    const [event] = normalize(scoresRecord({ scoreSoccer: undefined }), { lastScoreByFixture });
    expect(event?.score).toEqual(carried);
  });

  it('classifies pure stat updates', () => {
    const lastPhaseByFixture = new Map<number, GamePhase>([[FIXTURE_ID, 'H1']]);
    const [event] = normalize(
      scoresRecord({ stats: { '1': 2, '7': 4 }, scoreSoccer: undefined }),
      { lastPhaseByFixture },
    );
    expect(event?.kind).toBe('stat_update');
  });

  it('sorts batches by seq', () => {
    const events = normalize([scoresRecord({ seq: 5 }), scoresRecord({ seq: 3 })]);
    expect(events.map((e) => e.seq)).toEqual([3, 5]);
  });

  it('skips unparseable records and logs', () => {
    const logger = vi.fn();
    const events = normalizeScores([{ nonsense: true }], RECEIVED_AT_MS, { logger });
    expect(events).toEqual([]);
    expect(logger).toHaveBeenCalledWith('skipping unparseable scores record', expect.anything());
  });
});

describe('normalizeScores — additional time', () => {
  it('never writes the announced stoppage Minutes into MatchEvent.minute', () => {
    const lastPhaseByFixture = new Map<number, GamePhase>([[FIXTURE_ID, 'H2']]);
    const [event] = normalize(
      scoresRecord({
        action: 'additional_time',
        statusSoccerId: 4,
        dataSoccer: { Minutes: 6 },
        Clock: { Running: true, Seconds: 5_403 }, // 90:03
      }),
      { lastPhaseByFixture },
    );
    expect(event?.minute).toBe(91); // from the clock — NOT 6
    expect(event?.phase).toBe('H2');
  });

  it('leaves the minute null on additional_time without a clock', () => {
    const [event] = normalize(
      scoresRecord({ action: 'additional_time', dataSoccer: { Minutes: 4 } }),
    );
    expect(event?.minute).toBeNull();
  });
});

describe('goals-90 bookkeeping (FT vs FT_90 settlement)', () => {
  it('mirrors the total during regulation', () => {
    const record = scoresRecordSchema.parse(
      scoresRecord({
        statusSoccerId: 4,
        scoreSoccer: scoreSoccer({ Total: period(2) }, { Total: period(0) }),
      }),
    );
    const state = buildScoreState(record, 'H2');
    expect(state?.p1Goals90).toBe(2);
    expect(state?.p2Goals90).toBe(0);
  });

  it('uses the H1+H2 breakdown once extra-time periods appear', () => {
    const [event] = normalize(
      scoresRecord({
        statusSoccerId: 'ET1',
        scoreSoccer: scoreSoccer(
          { H1: period(1), H2: period(1), ET1: period(1), Total: period(3) },
          { H1: period(1), H2: period(1), ET1: period(0), Total: period(2) },
        ),
      }),
    );
    expect(event?.score.p1.goals).toBe(3);
    expect(event?.score.p1Goals90).toBe(2);
    expect(event?.score.p2Goals90).toBe(2);
  });

  it('reports null goals-90 in ET when the breakdown is missing', () => {
    const [event] = normalize(
      scoresRecord({
        statusSoccerId: 'ET2',
        scoreSoccer: scoreSoccer({ ET1: period(1), Total: period(3) }, { Total: period(2) }),
      }),
    );
    expect(event?.score.p1Goals90).toBeNull();
  });

  it('locks goals-90 at WET (mapped to HTET) before extra time starts', () => {
    const [event] = normalize(
      scoresRecord({
        statusSoccerId: 'WET',
        scoreSoccer: scoreSoccer(
          { H1: period(1), H2: period(0), Total: period(1) },
          { H1: period(0), H2: period(1), Total: period(1) },
        ),
      }),
    );
    expect(event?.phase).toBe('HTET');
    expect(event?.score.p1Goals90).toBe(1);
    expect(event?.score.p2Goals90).toBe(1);
  });

  it('excludes penalty-shootout goals from team tallies when summing periods', () => {
    const [event] = normalize(
      scoresRecord({
        statusSoccerId: 'FPE',
        scoreSoccer: scoreSoccer(
          { H1: period(1), H2: period(0), ET1: period(0), ET2: period(0), PE: period(4) },
          { H1: period(0), H2: period(1), ET1: period(0), ET2: period(0), PE: period(3) },
        ),
      }),
    );
    expect(event?.score.p1.goals).toBe(1);
    expect(event?.score.p2.goals).toBe(1);
    expect(event?.score.p1Goals90).toBe(1);
  });
});

describe('normalizeScores — synthetic live wire sequence', () => {
  it('normalizes a dump-shaped pre-match + in-play sequence end to end', () => {
    const fixtureId = 77_100_200;
    const baseWire = {
      FixtureId: fixtureId,
      GameState: 'scheduled',
      StartTime: KICKOFF_MS,
      IsTeam: true,
      FixtureGroupId: 5,
      CompetitionId: 6,
      CountryId: 7,
      SportId: 1,
      Participant1IsHome: true,
      Participant1Id: 10,
      Participant2Id: 20,
      CoverageSecondaryData: true,
      CoverageType: 'Venue',
      ConnectionId: 3,
      Data: {},
      Stats: {},
    };
    const sequence = [
      { ...baseWire, Action: 'coverage_update', Id: 0, Seq: 0, Ts: KICKOFF_MS - 86_400_000 },
      { ...baseWire, Action: 'comment', Id: 1, Seq: 1, Ts: KICKOFF_MS - 86_399_000 },
      {
        ...baseWire,
        Action: 'comment',
        Id: 40,
        Seq: 100,
        Ts: KICKOFF_MS + 30 * 60_000,
        StatusId: 2,
        Type: 'Soccer',
        Clock: { Running: true, Seconds: 1_799 },
        Confirmed: true,
        Data: { Goal: true, Participant: 1, PlayerId: 3_003 },
        Score: {
          Participant1: { H1: { Goals: 1 }, Total: { Goals: 1 } },
          Participant2: {},
        },
        Stats: { '1': 1 },
      },
    ];
    const maps = freshEventMaps();
    const lastPhaseByFixture = new Map<number, GamePhase>();
    const events = normalize(sequence, { ...maps, lastPhaseByFixture });

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 100]);
    // Pre-match notices: NS, and never coverage warnings or amendments.
    expect(events[0]?.phase).toBe('NS');
    expect(events[0]?.kind).not.toBe('coverage_warning');
    expect(events[0]?.kind).not.toBe('goal_amended');
    expect(events[1]?.phase).toBe('NS');
    // The confirmed in-play goal.
    expect(events[2]?.kind).toBe('goal');
    expect(events[2]?.confirmed).toBe(true);
    expect(events[2]?.phase).toBe('H1');
    expect(events[2]?.minute).toBe(30);
    expect(events[2]?.score.p1.goals).toBe(1);
    expect(events[2]?.detail?.playerNormativeId).toBe(3_003);
  });
});
