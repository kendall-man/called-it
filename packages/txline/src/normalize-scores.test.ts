import { describe, expect, it, vi } from 'vitest';
import type { GamePhase, ScoreState } from '@calledit/market-engine';
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

describe('statusSoccerId → GamePhase mapping', () => {
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
    // wrapper encodings of the oneOf-of-empty-objects spec shape
    [{ F: {} }, 'F'],
    [{ type: 'ET1' }, 'ET1'],
    // unknowns
    ['ZZZ', null],
    [42, null],
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

  it('treats missing confirmed as confirmed, explicit false as unconfirmed', () => {
    const [implicit] = normalize(scoresRecord({ confirmed: undefined, dataSoccer: { Goal: true } }));
    const [explicit] = normalize(scoresRecord({ confirmed: false, dataSoccer: { Goal: true } }));
    expect(implicit?.confirmed).toBe(true);
    expect(explicit?.confirmed).toBe(false);
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
    const events = normalize([
      scoresRecord({ seq: 10, id: 900, dataSoccer: { Goal: true, Participant: 1, PlayerId: 1 } }),
      scoresRecord({
        seq: 12,
        id: 900,
        action: 'Amend',
        dataSoccer: { Goal: true, Participant: 1, PlayerId: 2 },
      }),
    ]);
    expect(events.map((e) => e.kind)).toEqual(['goal', 'goal_amended']);
    expect(events[1]?.detail?.reversesSeq).toBe(10);
  });

  it('resolves reversesSeq across calls through a shared seqByEventId map', () => {
    const seqByEventId = new Map<number, number>();
    normalize(scoresRecord({ seq: 10, id: 900, dataSoccer: { Goal: true } }), { seqByEventId });
    const [discarded] = normalize(
      scoresRecord({ seq: 13, id: 900, action: 'Discard', dataSoccer: { Goal: true } }),
      { seqByEventId },
    );
    expect(discarded?.kind).toBe('goal_discarded');
    expect(discarded?.detail?.reversesSeq).toBe(10);
  });

  it('chains amendments: a second amend reverses the first amend', () => {
    const events = normalize([
      scoresRecord({ seq: 5, id: 77, dataSoccer: { Goal: true } }),
      scoresRecord({ seq: 9, id: 77, action: 'Amend', dataSoccer: { Goal: true } }),
      scoresRecord({ seq: 12, id: 77, action: 'Amend', dataSoccer: { Goal: true } }),
    ]);
    expect(events[2]?.detail?.reversesSeq).toBe(9);
  });

  it('logs when an amend cannot resolve its original event', () => {
    const logger = vi.fn();
    const [event] = normalizeScores(
      scoresRecord({ seq: 13, id: 901, action: 'Amend', dataSoccer: { Goal: true } }),
      RECEIVED_AT_MS,
      { logger },
    );
    expect(event?.kind).toBe('goal_amended');
    expect(event?.detail?.reversesSeq).toBeUndefined();
    expect(logger).toHaveBeenCalledWith(
      'amend/discard without resolvable original seq',
      expect.objectContaining({ eventId: 901 }),
    );
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

  it('classifies lineup records', () => {
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

  it('classifies possible-event flags (freeze trigger)', () => {
    const [event] = normalize(
      scoresRecord({
        parti1StateSoccer: { PossibleEvent: { Goal: true, Penalty: false, Corner: false } },
      }),
    );
    expect(event?.kind).toBe('possible_event');
  });

  it('classifies coverage-lost statuses as coverage_warning with COV_LOST phase', () => {
    const [event] = normalize(scoresRecord({ statusSoccerId: 'TXCS' }));
    expect(event?.kind).toBe('coverage_warning');
    expect(event?.phase).toBe('COV_LOST');
  });
});

describe('normalizeScores — phase and score bookkeeping', () => {
  it('emits phase_change only on actual transitions', () => {
    const lastPhaseByFixture = new Map<number, GamePhase>();
    const [first] = normalize(scoresRecord({ seq: 1, statusSoccerId: 'H1' }), { lastPhaseByFixture });
    const [repeat] = normalize(scoresRecord({ seq: 2, statusSoccerId: 'H1' }), { lastPhaseByFixture });
    const [transition] = normalize(scoresRecord({ seq: 3, statusSoccerId: 'HT' }), {
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

  it('carries the last known score forward when scoreSoccer is missing', () => {
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

describe('goals-90 bookkeeping (FT vs FT_90 settlement)', () => {
  it('mirrors the total during regulation', () => {
    const record = scoresRecordSchema.parse(
      scoresRecord({
        statusSoccerId: 'H2',
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
