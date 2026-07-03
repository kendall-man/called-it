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

/** A synthesized Scores record; override any field per test. */
export function scoresRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fixtureId: FIXTURE_ID,
    gameState: 'InPlay',
    startTime: KICKOFF_MS,
    isTeam: true,
    fixtureGroupId: 1,
    competitionId: 501,
    countryId: 100,
    sportId: 10,
    participant1IsHome: true,
    participant1Id: 111,
    participant2Id: 222,
    action: 'Insert',
    id: 5000,
    ts: KICKOFF_MS + 60_000,
    connectionId: 42,
    seq: 1,
    confirmed: true,
    statusSoccerId: 'H1',
    scoreSoccer: scoreSoccer({ Total: period() }, { Total: period() }),
    ...overrides,
  };
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
