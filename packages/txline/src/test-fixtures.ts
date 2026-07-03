/**
 * SYNTHESIZED TxLINE payload fixtures for tests.
 *
 * Shapes follow the OpenAPI spec at https://txline.txodds.com/docs/docs.yaml
 * (Scores, OddsPayload, Fixture). Every value here is invented — NO real
 * TxLINE feed data is recorded anywhere in this repo (data licence).
 */

export const FIXTURE_ID = 9001;
export const KICKOFF_MS = 1_780_000_000_000;

export interface PeriodScoreShape {
  Goals: number;
  YellowCards: number;
  RedCards: number;
  Corners: number;
}

export function period(goals = 0, yellow = 0, red = 0, corners = 0): PeriodScoreShape {
  return { Goals: goals, YellowCards: yellow, RedCards: red, Corners: corners };
}

export function scoreSoccer(
  p1: Record<string, PeriodScoreShape>,
  p2: Record<string, PeriodScoreShape>,
): Record<string, unknown> {
  return { Participant1: p1, Participant2: p2 };
}

/** Wire StatusId is numeric: 1-based ordinal of the spec's status oneOf (2 = H1). */
export const WIRE_STATUS_H1 = 2;

/**
 * Older tests were written against the OpenAPI spec's camelCase Scores field
 * names; the live wire (and this fixture) is PascalCase. Overrides in either
 * spelling land on the wire key so both generations of tests compose.
 */
const SCORES_OVERRIDE_KEY_ALIASES: Readonly<Record<string, string>> = {
  fixtureId: 'FixtureId',
  gameState: 'GameState',
  startTime: 'StartTime',
  isTeam: 'IsTeam',
  fixtureGroupId: 'FixtureGroupId',
  competitionId: 'CompetitionId',
  countryId: 'CountryId',
  sportId: 'SportId',
  participant1IsHome: 'Participant1IsHome',
  participant1Id: 'Participant1Id',
  participant2Id: 'Participant2Id',
  action: 'Action',
  id: 'Id',
  ts: 'Ts',
  connectionId: 'ConnectionId',
  seq: 'Seq',
  confirmed: 'Confirmed',
  participant: 'Participant',
  statusSoccerId: 'StatusId',
  scoreSoccer: 'Score',
  dataSoccer: 'Data',
  stats: 'Stats',
  lineups: 'Lineups',
  possibleEventSoccer: 'PossibleEvent',
  parti1StateSoccer: 'Parti1State',
  parti2StateSoccer: 'Parti2State',
  type: 'Type',
  clock: 'Clock',
};

/**
 * A synthesized Scores record in the observed wire shape (PascalCase keys,
 * numeric StatusId, Data/Stats envelopes always present); override any field
 * per test.
 */
export function scoresRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    FixtureId: FIXTURE_ID,
    GameState: 'scheduled',
    StartTime: KICKOFF_MS,
    IsTeam: true,
    FixtureGroupId: 1,
    CompetitionId: 501,
    CountryId: 100,
    SportId: 10,
    Participant1IsHome: true,
    Participant1Id: 111,
    Participant2Id: 222,
    Action: 'Insert',
    Id: 5000,
    Ts: KICKOFF_MS + 60_000,
    ConnectionId: 42,
    Seq: 1,
    Confirmed: true,
    StatusId: WIRE_STATUS_H1,
    Type: 'Soccer',
    Score: scoreSoccer({ Total: period() }, { Total: period() }),
    Data: {},
    Stats: {},
  };
  for (const [key, value] of Object.entries(overrides)) {
    record[SCORES_OVERRIDE_KEY_ALIASES[key] ?? key] = value;
  }
  return record;
}

/** A synthesized OddsPayload record; override any field per test. */
export function oddsRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    FixtureId: FIXTURE_ID,
    MessageId: 'msg-1',
    Ts: KICKOFF_MS - 600_000,
    Bookmaker: 'StablePrice',
    BookmakerId: 1,
    SuperOddsType: '1X2',
    GameState: 'Running',
    InRunning: false,
    MarketPeriod: 'M',
    PriceNames: ['1', 'X', '2'],
    Prices: [2200, 3550, 3800],
    Pct: ['45.500', '28.100', '26.400'],
    ...overrides,
  };
}

export function totalsRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return oddsRecord({
    MessageId: 'msg-totals-1',
    SuperOddsType: 'OU',
    MarketParameters: 'total=2.5',
    PriceNames: ['Over', 'Under'],
    Prices: [1920, 1880],
    Pct: ['52.000', '48.000'],
    ...overrides,
  });
}

/** A synthesized Fixture record. */
export function fixtureRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Ts: KICKOFF_MS - 86_400_000,
    StartTime: KICKOFF_MS,
    Competition: 'Test Cup',
    CompetitionId: 501,
    FixtureGroupId: 1,
    Participant1Id: 111,
    Participant1: 'Alpha FC',
    Participant2Id: 222,
    Participant2: 'Beta United',
    FixtureId: FIXTURE_ID,
    Participant1IsHome: true,
    ...overrides,
  };
}
