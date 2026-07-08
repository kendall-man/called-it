/**
 * Shared builders for the vitest suite. Not exported from the package.
 * Deterministic time base — no Date.now() anywhere.
 */
import type {
  ClaimType,
  Comparator,
  CompileContext,
  GamePhase,
  MarketSpec,
  MarketState,
  MatchEvent,
  MatchEventKind,
  OddsInputs,
  Period,
  PlayerRef,
  Position,
  RawClaimParse,
  ScoreState,
  TeamRef,
} from './types.js';
import { TUNABLES } from './constants.js';

export const FIXTURE_ID = 9001;
export const OTHER_FIXTURE_ID = 4242;
export const P1_NAME = 'France';
export const P2_NAME = 'Argentina';
export const PLAYER_MBAPPE = { normativeId: 700, name: 'Kylian Mbappé' };
export const PLAYER_MESSI = { normativeId: 800, name: 'Lionel Messi' };

/** Deterministic clock anchors. */
export const T0 = 1_760_000_000_000;
export const KICKOFF_MS = T0 + 3_600_000;
/** Feed delay used to derive receivedAtMs from tsMs in synthetic events. */
export const FEED_DELAY_MS = TUNABLES.ASSUMED_FEED_DELAY_MS;

export function teamRef(participant: 1 | 2, name?: string): TeamRef {
  return {
    kind: 'team',
    participant,
    name: name ?? (participant === 1 ? P1_NAME : P2_NAME),
  };
}

export function playerRef(
  participant: 1 | 2 | null = 1,
  base = PLAYER_MBAPPE,
): PlayerRef {
  return { kind: 'player', ...base, participant };
}

export function mkSpec(overrides: Partial<MarketSpec> = {}): MarketSpec {
  return {
    claimType: 'team_scores_n',
    fixtureId: FIXTURE_ID,
    entityRef: teamRef(1),
    comparator: 'gte',
    threshold: 2,
    period: 'FT_90',
    trustTier: 'chain_proven',
    ...overrides,
  };
}

export function mkScore(
  p1Goals: number,
  p2Goals: number,
  overrides: Partial<ScoreState> = {},
): ScoreState {
  return {
    p1: { goals: p1Goals, yellowCards: 0, redCards: 0, corners: 0 },
    p2: { goals: p2Goals, yellowCards: 0, redCards: 0, corners: 0 },
    p1Goals90: null,
    p2Goals90: null,
    ...overrides,
  };
}

export interface EventOverrides extends Partial<Omit<MatchEvent, 'detail'>> {
  detail?: MatchEvent['detail'];
}

export function mkEvent(
  kind: MatchEventKind,
  seq: number,
  overrides: EventOverrides = {},
): MatchEvent {
  const tsMs = overrides.tsMs ?? KICKOFF_MS + seq * 1_000;
  return {
    kind,
    fixtureId: FIXTURE_ID,
    seq,
    tsMs,
    receivedAtMs: overrides.receivedAtMs ?? tsMs + FEED_DELAY_MS,
    confirmed: true,
    phase: 'H1',
    minute: 10,
    score: mkScore(0, 0),
    ...overrides,
  };
}

export function mkPosition(
  id: string,
  overrides: Partial<Position> = {},
): Position {
  return {
    id,
    userId: `user-${id}`,
    side: 'back',
    stake: 50,
    lockedMultiplier: 3,
    placedAtMs: KICKOFF_MS,
    state: 'pending',
    ...overrides,
  };
}

export function mkState(
  spec: MarketSpec,
  overrides: Partial<MarketState> = {},
): MarketState {
  return {
    marketId: 'market-1',
    spec,
    status: 'open',
    positions: [],
    pendingSettlement: null,
    createdAtMs: T0,
    ...overrides,
  };
}

export function mkParse(overrides: Partial<RawClaimParse> = {}): RawClaimParse {
  return {
    claimType: null,
    fixtureId: null,
    entityName: null,
    entityKind: null,
    comparator: null,
    threshold: null,
    period: null,
    unresolved: null,
    ...overrides,
  };
}

export interface CtxOverrides {
  fixture?: Partial<NonNullable<CompileContext['fixture']>> | null;
  knownPlayers?: CompileContext['knownPlayers'];
  nowMs?: number;
}

export function mkCtx(overrides: CtxOverrides = {}): CompileContext {
  const fixture =
    overrides.fixture === null
      ? null
      : {
          fixtureId: FIXTURE_ID,
          p1Name: P1_NAME,
          p2Name: P2_NAME,
          kickoffMs: KICKOFF_MS,
          phase: 'NS' as GamePhase,
          minute: null,
          score: { p1Goals: 0, p2Goals: 0 },
          lastSeq: 0,
          coverageUnreliable: false,
          ...overrides.fixture,
        };
  return {
    fixture,
    knownPlayers: overrides.knownPlayers ?? [
      { ...PLAYER_MBAPPE, participant: 1 },
      { ...PLAYER_MESSI, participant: 2 },
    ],
    nowMs: overrides.nowMs ?? T0,
  };
}

export function mkOdds(overrides: Partial<OddsInputs> = {}): OddsInputs {
  return {
    p1x2: { home: 0.5, draw: 0.3, away: 0.2 },
    totals: { line: 2.5, overProb: 0.6 },
    oddsMessageId: 'msg-123',
    oddsTsMs: T0,
    ...overrides,
  };
}

/**
 * Consumer-copy deny list (compliance): the product owns betting language now,
 * so only odds NOTATION and FIAT currency stay banned — amounts are devnet SOL,
 * prices are plain percentages.
 */
export const DENIED_COPY_PATTERNS: readonly RegExp[] = [
  /[$£€¥]/u,
  /\b(dollars?|euros?|pounds?|usd|gbp|eur)\b/i,
  /\b\d+\s*\/\s*\d+\b/, // "11/1" fractional odds notation
  /\b\d+\s*-?\s*to\s*-?\s*\d+\b/i, // "9 to 1"
];

export function assertCleanCopy(text: string): string[] {
  return DENIED_COPY_PATTERNS.filter((p) => p.test(text)).map((p) =>
    String(p),
  );
}

/** Convenience: threshold constants mirrored for test readability. */
export const MINT_CUTOFF = TUNABLES.INPLAY_MINT_CUTOFF_MINUTE;
export const STAKE_CUTOFF = TUNABLES.INPLAY_STAKE_CUTOFF_MINUTE;
export const DEBOUNCE_MS = TUNABLES.SETTLEMENT_DEBOUNCE_MS;
