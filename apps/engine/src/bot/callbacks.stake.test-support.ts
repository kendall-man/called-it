// allow: SIZE_OK - base pure LOC 305; only feature delta is the typed/bounded point-method test stub needed by EngineDb/card refresh.
import type { Context } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import { renderFallback } from './copy.js';
import type { HandlerCtx } from './context.js';
import type { ClaimRow, EngineDb, FixtureRow, MarketRow, PositionRow } from '../ports.js';
import { LlmBudget } from './budget.js';
import { createWagerModule } from '../wager/module.js';
import { makeFakeDeps, type FakeWagerDb } from '../wager/fakes.js';
import { createPointMethodStubs, type PointMethodStubs } from '../points/point-methods.test-support.js';
import { EntityCache } from './entities.js';
import { SendQueue } from './sendQueue.js';

export const NOW = Date.parse('2026-07-06T18:00:00.000Z');
export const CHAT_ID = -100999;
export const USER_A = 8001;
export const MARKET_ID = 'a1111111-1111-4111-8111-111111111111';
export const FIXTURE_ID = 77;
export const PRESET_01 = 0;

export function fixtureAt(phase: FixtureRow['phase'], minute: number | null): FixtureRow {
  return {
    fixture_id: FIXTURE_ID,
    p1_name: 'Brazil',
    p2_name: 'Norway',
    kickoff_at: new Date(NOW + 3_600_000).toISOString(),
    phase,
    minute,
    last_seq: 0,
    score: {},
    coverage_unreliable: false,
  };
}

export function stakeMarket(overrides: Partial<MarketRow> = {}): MarketRow {
  const spec: MarketRow['spec'] = {
    claimType: 'match_winner',
    fixtureId: FIXTURE_ID,
    entityRef: { kind: 'team', participant: 1, name: 'Brazil' },
    comparator: 'gte',
    threshold: 1,
    period: 'FT_90',
    trustTier: 'oracle_resolved',
  };
  return {
    id: MARKET_ID,
    claim_id: 'claim-1',
    group_id: CHAT_ID,
    fixture_id: FIXTURE_ID,
    spec,
    status: 'open',
    is_replay: false,
    price_provenance: 'market',
    quote_probability: 0.5,
    quote_multiplier: 2,
    odds_message_id: 'om-1',
    odds_ts: NOW - 1000,
    card_tg_message_id: null,
    created_at: new Date(NOW).toISOString(),
    currency: 'sol',
    ...overrides,
  };
}

export interface StakeHarness {
  h: HandlerCtx;
  wagerDb: FakeWagerDb;
  cardEdits: Array<{ chatId: number; marketId: string; messageId: number }>;
}

export interface StakeHarnessOptions {
  marketRow?: MarketRow;
  fixture?: FixtureRow;
  balanceLamports?: bigint | null;
  link?: boolean;
  starterGrantsEnabled?: boolean;
  stakeAcceptanceEnabled?: boolean;
  starterBudgetEnabled?: boolean;
  refreshableCard?: boolean;
}

type StakeDb = Pick<
  EngineDb,
  | 'getMarket'
  | 'getFixture'
  | 'getUser'
  | 'upsertUser'
  | 'ensureMembership'
  | 'getClaim'
  | 'getGroup'
  | 'positionsForMarket'
  | 'setMarketCardMessage'
> & PointMethodStubs;

interface StakeDeps {
  db: EngineDb;
  agent: object;
  engine: object;
  tx: object;
  proofSubmitter: object | null;
  wager: ReturnType<typeof createWagerModule> | null;
  readiness: object;
  drains: readonly object[];
  env: object;
  log: object;
  now(): number;
}

interface StakeHandler {
  deps: StakeDeps;
  poster: {
    post: () => void;
    editCard: (chatId: number, marketId: string, messageId: number) => void;
    stripKeyboard: () => void;
  };
  say: (key: Parameters<typeof renderFallback>[0], vars?: Parameters<typeof renderFallback>[1]) => Promise<string>;
  supervisor: object;
  budget: LlmBudget;
  queue: SendQueue;
  entities: EntityCache;
}

interface StakeCallbackContext {
  chat: { id: number };
  from: { id: number; first_name: string };
  callbackQuery: { id: string };
  answerCallbackQuery(
    payload: Parameters<Context['answerCallbackQuery']>[0],
  ): Promise<true>;
}

function asEngineDb(db: StakeDb): EngineDb {
  return db as EngineDb;
}

function asHandlerContext(h: StakeHandler): HandlerCtx {
  return h as HandlerCtx;
}

function asCallbackContext(ctx: StakeCallbackContext): Context {
  return ctx as Context;
}

function installAtomicStarterRpc(db: FakeWagerDb, starterBudgetEnabled: boolean): void {
  const standardStake = db.wagerStake.bind(db);
  const locks = new Map<number, Promise<void>>();
  db.wagerStake = async (args) => {
    const prior = locks.get(args.user_id) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => current);
    locks.set(args.user_id, queued);
    await prior;
    try {
      const ledgerKey = `wager:stake:api:${args.idempotency_key ?? ''}`;
      db.lastStakeArgs = args;
      if (args.idempotency_key !== undefined && db.ledgerByKey(ledgerKey) !== undefined) {
        return { ok: true, duplicate: true };
      }
      const hasHistory =
        db.ledger.some((entry) => entry.user_id === args.user_id) ||
        db.positions.some((position) => position.user_id === args.user_id);
      if (args.allow_starter && args.lamports === 10_000_000n && !hasHistory) {
        if (!starterBudgetEnabled) return { ok: false, code: 'starter_unavailable' };
        const oppositeSide = db.positions.some(
          (position) =>
            position.market_id === args.market_id &&
            position.user_id === args.user_id &&
            position.side !== args.side &&
            position.state !== 'void',
        );
        if (oppositeSide) return { ok: false, code: 'wrong_side' };
        const positionId = `starter-position-${db.positions.length + 1}`;
        db.positions.push({
          id: positionId,
          market_id: args.market_id,
          user_id: args.user_id,
          side: args.side,
          stake: Number(args.lamports),
          locked_multiplier: args.multiplier,
          state: args.state,
          placed_at_ms: args.placed_at_ms,
        });
        await db.postWagerLedger({
          user_id: args.user_id,
          group_id: args.group_id,
          market_id: args.market_id,
          kind: 'starter_grant',
          lamports: args.lamports,
          idempotency_key: `wager:starter:${args.user_id}`,
        });
        await db.postWagerLedger({
          user_id: args.user_id,
          group_id: args.group_id,
          market_id: args.market_id,
          kind: 'stake',
          lamports: -args.lamports,
          idempotency_key: ledgerKey,
        });
        return { ok: true, position_id: positionId };
      }
      if (!db.links.has(args.user_id)) return { ok: false, code: 'wallet_required' };
      return standardStake(args);
    } finally {
      release();
      if (locks.get(args.user_id) === queued) locks.delete(args.user_id);
    }
  };
}

export function makeStakeHarness(opts: StakeHarnessOptions = {}): StakeHarness {
  const wagerBundle = makeFakeDeps({
    now: () => NOW,
    starterGrantsEnabled: opts.starterGrantsEnabled ?? false,
    walletMiniappEnabled: false,
    stakeAcceptanceEnabled: opts.stakeAcceptanceEnabled ?? false,
  });
  installAtomicStarterRpc(wagerBundle.db, opts.starterBudgetEnabled ?? true);
  const wager = createWagerModule(wagerBundle.deps);
  if (opts.link ?? true) wagerBundle.db.seedLink(USER_A, 'Wa11etPubkey1111111111111111111111111111');
  const balanceLamports =
    opts.balanceLamports === undefined ? 1_000_000_000n : opts.balanceLamports;
  if (balanceLamports !== null) wagerBundle.db.seedBalance(USER_A, balanceLamports);
  wagerBundle.db.seedMarketProbability(MARKET_ID, 0.5);

  const market = opts.marketRow ?? stakeMarket();
  if (opts.refreshableCard) market.card_tg_message_id = 900;
  const claim: ClaimRow | null = opts.refreshableCard
    ? {
        id: 'claim-1',
        group_id: CHAT_ID,
        claimer_user_id: USER_A,
        tg_message_id: 1,
        quoted_text: 'Brazil win',
        status: 'confirmed',
        classifier_confidence: 1,
        parse: null,
        expires_at: null,
        created_at: new Date(NOW).toISOString(),
      }
    : null;
  const cardEdits: Array<{ chatId: number; marketId: string; messageId: number }> = [];
  const db = asEngineDb({
    ...createPointMethodStubs({ kind: 'empty', groupId: CHAT_ID }),
    getMarket: async (id: string) => (id === market.id ? { ...market } : null),
    getFixture: async () => opts.fixture ?? fixtureAt('NS', null),
    getUser: async (id: number) => ({ id, display_name: `U${id}`, username: null }),
    upsertUser: async () => undefined,
    ensureMembership: async () => ({ created: false }),
    getClaim: async () => claim,
    getGroup: async () => ({
      id: CHAT_ID,
      slug: 'g',
      title: 'G',
      web_enabled: true,
      chattiness: 'nudge' as const,
      is_admin: true,
    }),
    positionsForMarket: async (): Promise<PositionRow[]> => wagerBundle.db.positions,
    setMarketCardMessage: async () => undefined,
  });
  const h = asHandlerContext({
    deps: {
      db,
      agent: {},
      engine: {},
      tx: {},
      proofSubmitter: null,
      wager,
      readiness: {},
      drains: [],
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => NOW,
      env: {
        WEB_BASE_URL: 'https://web.test',
        STARTER_GRANTS_ENABLED: opts.starterGrantsEnabled ?? false,
        WALLET_MINIAPP_ENABLED: false,
        STAKE_ACCEPTANCE_ENABLED: opts.stakeAcceptanceEnabled ?? false,
      },
    },
    poster: {
      post: () => undefined,
      editCard: (chatId: number, marketId: string, messageId: number) => {
        cardEdits.push({ chatId, marketId, messageId });
      },
      stripKeyboard: () => undefined,
    },
    say: async (key: Parameters<typeof renderFallback>[0], vars = {}) => renderFallback(key, vars),
    supervisor: { replayFixture: () => null },
    budget: new LlmBudget(1000, () => NOW),
    queue: new SendQueue({ ratePerMinute: 1, collapseMs: 0, now: () => NOW }),
    entities: new EntityCache(db, () => NOW),
  });
  return { h, wagerDb: wagerBundle.db, cardEdits };
}

export function makeStakeContext(
  userId: number,
  callbackId = 'callback-1',
): { ctx: Context; toasts: string[] } {
  const toasts: string[] = [];
  const ctx = asCallbackContext({
    chat: { id: CHAT_ID },
    from: { id: userId, first_name: `U${userId}` },
    callbackQuery: { id: callbackId },
    answerCallbackQuery: async (payload) => {
      if (typeof payload !== 'string' && payload !== undefined && 'text' in payload) {
        toasts.push(typeof payload.text === 'string' ? payload.text : '');
      }
      return true;
    },
  });
  return { ctx, toasts };
}

export const stakeAction = (side: 'back' | 'doubt', presetIndex: 0) =>
  ({ t: 'stake', marketId: MARKET_ID, side, presetIndex }) as const;

export const INPLAY_CUTOFF = TUNABLES.INPLAY_STAKE_CUTOFF_MINUTE;
