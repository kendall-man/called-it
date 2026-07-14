import type { Server } from 'node:http';
import type { Env } from '../env.js';
import type { Logger } from '../log.js';
import type { Deps, EngineDb, FixtureRow, MarketRow } from '../ports.js';
import type { Poster } from '../bot/poster.js';
import { createPointMethodStubs } from '../points/point-methods.test-support.js';
import { createWagerModule } from '../wager/module.js';
import { makeFakeDeps, type FakeWagerDb } from '../wager/fakes.js';
import { DrainState, createReadinessEvaluator, type ReadinessEvaluator } from './readiness.js';
import { startEngineApi, type TelegramIngressPort } from './server.js';
import { TEST_ENV } from './server-test-env.js';

export const NOW = Date.parse('2026-07-08T12:00:00.000Z');
export const CHAT_ID = -100555;
export const USER_ID = 9001;
export const MARKET_ID = '11111111-2222-4333-8444-555555555555';
export const CONCIERGE_TOKEN = TEST_ENV.ENGINE_CONCIERGE_TOKEN;
export const TELEGRAM_TOKEN = TEST_ENV.ENGINE_TELEGRAM_TOKEN;
export const OPS_TOKEN = TEST_ENV.ENGINE_OPS_TOKEN;
export const PUBKEY = 'Wa11etPubkey1111111111111111111111111111';
export const PRIVATE_DISPLAY_NAME = 'Private Participant Name', PRIVATE_USERNAME = 'private_participant_handle';

export const FIXTURE: FixtureRow = {
  fixture_id: 42,
  p1_name: 'Portugal',
  p2_name: 'Spain',
  kickoff_at: new Date(NOW + 3_600_000).toISOString(),
  phase: 'NS',
  minute: null,
  last_seq: 0,
  score: {},
  coverage_unreliable: false,
};

export const MARKET: MarketRow = {
  id: MARKET_ID,
  claim_id: 'claim-1',
  group_id: CHAT_ID,
  fixture_id: FIXTURE.fixture_id,
  spec: {
    claimType: 'match_winner',
    fixtureId: FIXTURE.fixture_id,
    entityRef: { kind: 'team', name: 'Spain', participant: 2 },
    comparator: 'gte',
    threshold: 1,
    period: 'FT_90',
    trustTier: 'chain_proven',
  },
  status: 'open',
  is_replay: false,
  price_provenance: 'market',
  quote_probability: 0.5,
  quote_multiplier: 2,
  odds_message_id: 'om-1',
  odds_ts: NOW - 1000,
  card_tg_message_id: null,
  currency: 'sol',
  created_at: new Date(NOW).toISOString(),
};

function unreachable(): never {
  throw new Error('unexpected test dependency call');
}

async function unreachableAsync(): Promise<never> {
  return unreachable();
}

function createLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => createLogger(),
  };
}

function createDb(theMarket: MarketRow): EngineDb {
  return {
    upsertGroup: unreachableAsync,
    getGroup: async (id) => id === CHAT_ID
      ? { id, title: 'Test Group', chattiness: 'nudge', web_enabled: true, slug: 'slug', is_admin: true } : null,
    setGroupChattiness: unreachableAsync,
    setGroupAdmin: unreachableAsync,
    setGroupWebEnabled: unreachableAsync,
    listGroups: unreachableAsync,
    upsertUser: async () => undefined,
    getUser: async (id) => id === USER_ID
      ? { id, display_name: PRIVATE_DISPLAY_NAME, username: PRIVATE_USERNAME } : null,
    ensureMembership: async () => ({ created: false }),
    listMemberships: unreachableAsync,
    balance: unreachableAsync,
    ...createPointMethodStubs({ kind: 'unreachable', call: unreachableAsync }),
    postLedger: unreachableAsync,
    hasLedgerEntry: unreachableAsync,
    insertClaim: unreachableAsync,
    getClaim: unreachableAsync,
    updateClaim: unreachableAsync,
    expireOverdueClaims: unreachableAsync,
    insertMarket: unreachableAsync,
    getMarket: async (id) => id === theMarket.id ? { ...theMarket } : null,
    updateMarketStatus: unreachableAsync,
    setMarketQuote: unreachableAsync,
    setMarketCardMessage: unreachableAsync,
    openMarketsForFixture: unreachableAsync,
    openMarketsForGroup: async () => [{ ...theMarket }],
    insertPosition: unreachableAsync,
    positionsForMarket: async () => [],
    setPositionStates: unreachableAsync,
    insertFeedEvent: unreachableAsync,
    insertSettlement: unreachableAsync,
    unpostedSettlements: unreachableAsync,
    markSettlementPosted: unreachableAsync,
    upsertProof: unreachableAsync,
    getCursor: unreachableAsync,
    setCursor: unreachableAsync,
    upsertFixtures: unreachableAsync,
    getFixture: async () => FIXTURE,
    fixturesBetween: async () => [FIXTURE],
    liveFixtures: unreachableAsync,
    updateFixtureFromEvent: unreachableAsync,
    searchFixtures: unreachableAsync,
    entityNames: unreachableAsync,
    playersForFixture: async () => [],
    searchPlayers: unreachableAsync,
  };
}

function createDeps(db: EngineDb, wager: Deps['wager'], log: Logger): Deps {
  return {
    db,
    wager,
    agent: {
      prefilter: unreachable,
      classify: unreachableAsync,
      parse: async () => ({
        claimType: 'match_winner', fixtureId: FIXTURE.fixture_id, entityName: 'Spain',
        entityKind: 'team', comparator: null, threshold: null, period: 'FT_90', unresolved: null,
      }),
      persona: unreachableAsync,
    },
    engine: {
      compileClaim: () => ({ kind: 'ok', spec: MARKET.spec }),
      priceSpec: () => ({
        probability: 0.5, multiplier: 2, provenance: 'market',
        oddsMessageId: 'om-1', oddsTsMs: NOW - 1000,
      }),
      reduceMarket: unreachable,
      checkDebounce: unreachable,
    },
    tx: {
      fetchOdds: async () => ({
        kind: 'ok',
        odds: {
          p1x2: { home: 0.3, draw: 0.2, away: 0.5 },
          totals: null,
          oddsMessageId: 'om-1',
          oddsTsMs: NOW - 1000,
        },
      }),
      fetchFixtures: unreachableAsync,
      fetchScoreEvents: unreachableAsync,
      fetchStatProof: unreachableAsync,
      createLiveSource: unreachable,
      createReplaySource: unreachable,
    },
    proofSubmitter: null,
    readiness: {
      database: { probe: async () => undefined },
      feed: { snapshot: async () => ({ activePricingExpected: false, lastEventAtMs: null }) },
      wager: { snapshot: async () => ({ enabled: false, configured: false, runtimeMatches: true, paused: false, covered: false, starterIntakeReady: false }) },
      proof: { snapshot: async () => ({ enabled: false, heartbeatAtMs: null, backlog: 0, oldestAgeMs: null }) },
      settlement: { snapshot: async () => ({ enabled: false, heartbeatAtMs: null, backlog: 0, oldestAgeMs: null }) },
    },
    drains: [],
    env: TEST_ENV,
    log,
    now: () => NOW,
  };
}

export interface ApiHarness {
  base: string;
  wagerDb: FakeWagerDb;
}

let activeServer: Server | null = null;

export async function closeActiveServer(): Promise<void> {
  const server = activeServer;
  activeServer = null;
  if (server === null) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function startHarness(options: {
  balanceLamports?: bigint;
  link?: boolean;
  market?: MarketRow;
  readiness?: ReadinessEvaluator;
  drainState?: DrainState;
  log?: Logger;
  env?: Partial<Env>;
  parse?: Deps['agent']['parse'];
  wager?: Deps['wager'];
  telegramIngress?: TelegramIngressPort;
  handleTelegramUpdate?: (update: Record<string, unknown>) => Promise<void>;
} = {}): Promise<ApiHarness> {
  const wagerBundle = makeFakeDeps({ now: () => NOW });
  const wager = options.wager === undefined ? createWagerModule(wagerBundle.deps) : options.wager;
  if (wager !== null) {
    if (options.link ?? true) wagerBundle.db.seedLink(USER_ID, PUBKEY);
    wagerBundle.db.seedBalance(USER_ID, options.balanceLamports ?? 1_000_000_000n);
    wagerBundle.db.seedMarketProbability(MARKET_ID, 0.5);
  }
  const log = options.log ?? createLogger();
  const deps = createDeps(createDb(options.market ?? MARKET), wager, log);
  if (options.parse !== undefined) {
    deps.agent.parse = options.parse;
  }
  const drainState = options.drainState ?? new DrainState();
  const readiness = options.readiness ?? createReadinessEvaluator({
    checks: [], checkTimeoutMs: 100,
    deadline: { wait: async () => new Promise<void>(() => undefined) }, drainState,
  });
  const env = {
    ...TEST_ENV,
    ...options.env,
    PORT: 0,
  };
  const poster: Poster = {
    post: () => undefined,
    editCard: () => undefined,
    stripKeyboard: () => undefined,
  };
  const server = startEngineApi({
    deps,
    poster,
    env,
    log,
    readiness,
    drainState,
    ...(options.telegramIngress
      ? { telegramIngress: options.telegramIngress }
      : {}),
    ...(options.handleTelegramUpdate
      ? { telegramIngress: { accept: options.handleTelegramUpdate } }
      : {}),
  });
  activeServer = server;
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('api did not bind a port');
  return { base: `http://${address.family === 'IPv6' ? '[::1]' : '127.0.0.1'}:${address.port}`, wagerDb: wagerBundle.db };
}

export const authed = {
  authorization: `Bearer ${CONCIERGE_TOKEN}`,
  'content-type': 'application/json',
};

export function stakeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    chatId: CHAT_ID, marketId: MARKET_ID, userId: USER_ID, displayName: 'Dee',
    side: 'back', amount: 0.05, idempotencyKey: 'call-abc-123', ...overrides,
  });
}
