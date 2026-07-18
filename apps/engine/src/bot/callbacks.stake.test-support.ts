import type { Context } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import { renderFallback } from './copy.js';
import type { HandlerCtx } from './context.js';
import type { ClaimRow, EngineDb, FixtureRow, MarketRow, PositionRow } from '../ports.js';
import { LlmBudget } from './budget.js';
import {
  createWagerModule,
  type WagerModule,
} from '../wager/module.js';
import { createStarterOnlyWagerModule } from '../wager/starter-only-module.js';
import { makeFakeDeps, type FakeWagerDb } from '../wager/fakes.js';
import { starterOnlyWagerDbFromFake } from '../wager/starter-fake.test-support.js';
import { createPointMethodStubs, type PointMethodStubs } from '../points/point-methods.test-support.js';
import { installAtomicStarterRpc } from './callbacks.starter-rpc.test-support.js';
import { EntityCache } from './entities.js';
import { SendQueue } from './sendQueue.js';
import type { EscrowTelegramPort } from './escrow-ux.js';
import type { EphemeralPort } from './ephemeral.js';
import { UiStateStore } from './stake-ui-state.js';
import type { InlineKeyboard } from 'grammy';

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
    custody_mode: 'legacy',
    ...overrides,
  };
}

/** The full card-edit capture (text + keyboard) for two-step surface tests. */
export interface CardSurfaceRecord {
  chatId: number;
  marketId: string;
  messageId: number;
  text?: string;
  keyboard?: InlineKeyboard;
  urgent?: boolean;
}

/** A per-user ephemeral SEND capture (the stepper's group-scoped private message). */
export interface EphemeralSendRecord {
  chatId: number;
  receiverUserId: number;
  callbackQueryId: string;
  text: string;
  keyboard?: InlineKeyboard;
  ephemeralMessageId: number;
}

/** A per-user ephemeral EDIT capture (an in-place stepper re-size or close). */
export interface EphemeralEditRecord {
  userId: number;
  ephemeralMessageId: number;
  text: string;
  keyboard?: InlineKeyboard;
}

export interface FakeEphemeral {
  port: EphemeralPort;
  /** Successful sends (a failed send is counted in sendCalls but not recorded). */
  sends: EphemeralSendRecord[];
  /** Successful edits (a failed edit is counted in editCalls but not recorded). */
  edits: EphemeralEditRecord[];
  /** Every send attempt, including ones that returned ok:false. */
  readonly sendCalls: number;
  /** Every edit attempt, including ones that returned false. */
  readonly editCalls: number;
}

/** Base id for fake ephemeral messages, so captured ids are recognizably distinct. */
const EPHEMERAL_MESSAGE_ID_BASE = 5000;

/**
 * A recording ephemeral port. `sendFails` models the API being unavailable (the
 * send throws / returns ok:false) so the fallback path can be asserted;
 * `editFails` models a failed in-place edit so the re-send path is exercised.
 */
function makeFakeEphemeral(opts: { sendFails?: boolean; editFails?: boolean } = {}): FakeEphemeral {
  const sends: EphemeralSendRecord[] = [];
  const edits: EphemeralEditRecord[] = [];
  let nextId = EPHEMERAL_MESSAGE_ID_BASE;
  const counters = { sendCalls: 0, editCalls: 0 };
  const port: EphemeralPort = {
    async send(input) {
      counters.sendCalls += 1;
      if (opts.sendFails === true) return { ok: false };
      const ephemeralMessageId = (nextId += 1);
      sends.push({
        chatId: input.chatId,
        receiverUserId: input.receiverUserId,
        callbackQueryId: input.callbackQueryId,
        text: input.text,
        keyboard: input.replyMarkup,
        ephemeralMessageId,
      });
      return { ok: true, ephemeralMessageId };
    },
    async edit(input) {
      counters.editCalls += 1;
      if (opts.editFails === true) return false;
      edits.push({
        userId: input.userId,
        ephemeralMessageId: input.ephemeralMessageId,
        text: input.text,
        keyboard: input.replyMarkup,
      });
      return true;
    },
  };
  return {
    port,
    sends,
    edits,
    get sendCalls() {
      return counters.sendCalls;
    },
    get editCalls() {
      return counters.editCalls;
    },
  };
}

export interface StakeHarness {
  h: HandlerCtx;
  wagerDb: FakeWagerDb;
  /** Backward-compatible id-only record; existing tests deep-equal this. */
  cardEdits: Array<{ chatId: number; marketId: string; messageId: number }>;
  /** Rich record (text + keyboard + urgent) for two-step surface assertions. */
  cardSurfaces: CardSurfaceRecord[];
  posts: Array<{ chatId: number; text: string; options: unknown }>;
  /** Present only when the two-step ladder flag is enabled. */
  uiState: UiStateStore | null;
  /** The recording ephemeral port; present only when the ladder flag is enabled. */
  ephemeral: FakeEphemeral | null;
}

export interface StakeHarnessOptions {
  marketRow?: MarketRow;
  fixture?: FixtureRow;
  replayFixture?: FixtureRow | null;
  balanceLamports?: bigint | null;
  link?: boolean;
  starterGrantsEnabled?: boolean;
  stakeAcceptanceEnabled?: boolean;
  starterBudgetEnabled?: boolean;
  refreshableCard?: boolean;
  solanaNetwork?: 'devnet' | 'mainnet-beta';
  custodyMode?: 'legacy' | 'escrow';
  escrow?: EscrowTelegramPort;
  /** Turns on the two-step stake ladder and attaches a UiStateStore + ephemeral port. */
  ladderEnabled?: boolean;
  /** Model the ephemeral send failing (API unavailable) to assert the fallback. */
  ephemeralSendFails?: boolean;
  /** Model the ephemeral in-place edit failing to assert the re-send path. */
  ephemeralEditFails?: boolean;
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
  | 'placeReplayPosition'
  | 'positionsForMarket'
  | 'setMarketCardMessage'
> & PointMethodStubs;

interface StakeDeps {
  db: EngineDb;
  agent: object;
  engine: object;
  tx: object;
  proofSubmitter: object | null;
  wager: WagerModule | null;
  readiness: object;
  drains: readonly object[];
  env: object;
  log: object;
  now(): number;
}

interface StakeHandler {
  deps: StakeDeps;
  poster: {
    post: (chatId: number, text: string, options?: unknown) => void;
    editCard: (
      chatId: number,
      marketId: string,
      messageId: number,
      text?: string,
      keyboard?: InlineKeyboard,
      options?: { urgent?: boolean },
    ) => void;
    stripKeyboard: () => void;
    react: (chatId: number, messageId: number, emoji: string) => void;
    chatAction: (chatId: number, action: string) => void;
  };
  uiState?: UiStateStore;
  ephemeral?: EphemeralPort;
  say: (key: Parameters<typeof renderFallback>[0], vars?: Parameters<typeof renderFallback>[1]) => Promise<string>;
  supervisor: object;
  budget: LlmBudget;
  queue: SendQueue;
  entities: EntityCache;
  escrow?: EscrowTelegramPort;
}

interface StakeCallbackContext {
  chat: { id: number };
  from: { id: number; first_name: string };
  callbackQuery: { id: string };
  answerCallbackQuery(
    payload: Parameters<Context['answerCallbackQuery']>[0],
  ): Promise<true>;
  api: {
    sendMessage(
      chatId: number,
      text: string,
      options?: unknown,
    ): Promise<unknown>;
  };
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

export function makeStakeHarness(opts: StakeHarnessOptions = {}): StakeHarness {
  const wagerBundle = makeFakeDeps({
    now: () => NOW,
    walletMiniappEnabled: false,
    stakeAcceptanceEnabled: opts.stakeAcceptanceEnabled ?? false,
    solanaNetwork: opts.solanaNetwork ?? 'devnet',
  });
  installAtomicStarterRpc(wagerBundle.db, opts.starterBudgetEnabled ?? true);
  const starterOnly =
    (opts.starterGrantsEnabled ?? false) && (opts.stakeAcceptanceEnabled ?? false);
  const wager = starterOnly
    ? createStarterOnlyWagerModule({
        runtimeMode: 'starter_only',
        db: starterOnlyWagerDbFromFake(wagerBundle.db),
        log: wagerBundle.deps.log,
        starterGrantsEnabled: true,
        stakeAcceptanceEnabled: true,
      })
    : createWagerModule(wagerBundle.deps);
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
  const cardSurfaces: CardSurfaceRecord[] = [];
  const posts: Array<{ chatId: number; text: string; options: unknown }> = [];
  // No-fire scheduler so auto-revert timers never run during a synchronous test.
  const uiStateStore = (opts.ladderEnabled ?? false)
    ? new UiStateStore({ now: () => NOW, schedule: () => () => undefined })
    : null;
  const ephemeral = (opts.ladderEnabled ?? false)
    ? makeFakeEphemeral({ sendFails: opts.ephemeralSendFails, editFails: opts.ephemeralEditFails })
    : null;
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
    placeReplayPosition: async (input) => {
      const duplicate = wagerBundle.db.positions.some(
        (position) => position.market_id === input.market_id && position.user_id === input.user_id,
      );
      if (duplicate) return { ok: true, duplicate: true };
      const positionId = `replay-position-${wagerBundle.db.positions.length + 1}`;
      wagerBundle.db.positions.push({
        id: positionId,
        market_id: input.market_id,
        user_id: input.user_id,
        side: input.side,
        stake: input.stake,
        locked_multiplier: input.locked_multiplier,
        state: input.state,
        placed_at_ms: input.placed_at_ms,
      });
      return { ok: true, duplicate: false, position_id: positionId };
    },
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
        SOLANA_NETWORK: opts.solanaNetwork ?? 'devnet',
        WAGER_CUSTODY_MODE: opts.custodyMode ?? 'legacy',
        STAKE_LADDER_ENABLED: opts.ladderEnabled ?? false,
        TELEGRAM_MINIAPP_SHORT_NAME: undefined,
      },
    },
    poster: {
      post: (chatId: number, text: string, options?: unknown) => {
        posts.push({ chatId, text, options });
      },
      editCard: (
        chatId: number,
        marketId: string,
        messageId: number,
        text?: string,
        keyboard?: InlineKeyboard,
        options?: { urgent?: boolean },
      ) => {
        cardEdits.push({ chatId, marketId, messageId });
        cardSurfaces.push({ chatId, marketId, messageId, text, keyboard, urgent: options?.urgent });
      },
      stripKeyboard: () => undefined,
      react: () => undefined,
      chatAction: () => undefined,
    },
    ...(uiStateStore === null ? {} : { uiState: uiStateStore }),
    ...(ephemeral === null ? {} : { ephemeral: ephemeral.port }),
    say: async (key: Parameters<typeof renderFallback>[0], vars = {}) => renderFallback(key, vars),
    supervisor: {
      replayFixture: () => opts.replayFixture?.fixture_id ?? null,
      replaySnapshot: () => opts.replayFixture ?? null,
      admitReplayPosition: async (market: MarketRow) => {
        if (!market.is_replay) return { kind: 'not_replay' as const };
        if (opts.replayFixture?.fixture_id !== market.fixture_id) {
          return { kind: 'stale' as const, reason: 'no_active_run' as const };
        }
        return {
          kind: 'allowed' as const,
          run: {
            groupId: market.group_id,
            fixtureId: market.fixture_id,
            runId: 1,
            startedAtMs: NOW,
          },
        };
      },
    },
    budget: new LlmBudget(1000, () => NOW),
    queue: new SendQueue({ ratePerMinute: 1, collapseMs: 0, now: () => NOW }),
    entities: new EntityCache(db, () => NOW),
    ...(opts.escrow === undefined ? {} : { escrow: opts.escrow }),
  });
  return { h, wagerDb: wagerBundle.db, cardEdits, cardSurfaces, posts, uiState: uiStateStore, ephemeral };
}

export function makeStakeContext(
  userId: number,
  callbackId = 'callback-1',
): {
  ctx: Context;
  toasts: string[];
  /** The subset of answers sent as modal alerts (show_alert: true). */
  alerts: string[];
  privateMessages: Array<{ readonly chatId: number; readonly text: string; readonly options: unknown }>;
} {
  const toasts: string[] = [];
  const alerts: string[] = [];
  const privateMessages: Array<{
    readonly chatId: number;
    readonly text: string;
    readonly options: unknown;
  }> = [];
  const ctx = asCallbackContext({
    chat: { id: CHAT_ID },
    from: { id: userId, first_name: `U${userId}` },
    callbackQuery: { id: callbackId },
    answerCallbackQuery: async (payload) => {
      if (typeof payload !== 'string' && payload !== undefined && 'text' in payload) {
        const text = typeof payload.text === 'string' ? payload.text : '';
        toasts.push(text);
        if ((payload as { readonly show_alert?: boolean }).show_alert === true) {
          alerts.push(text);
        }
      }
      return true;
    },
    api: {
      async sendMessage(chatId, text, options) {
        privateMessages.push({ chatId, text, options });
        return true;
      },
    },
  });
  return { ctx, toasts, alerts, privateMessages };
}

export const stakeAction = (side: 'back' | 'doubt', presetIndex: 0) =>
  ({ t: 'stake', marketId: MARKET_ID, side, presetIndex }) as const;

export const stakeValueAction = (side: 'back' | 'doubt', amountCode: 1 | 2 | 5 | 10) =>
  ({ t: 'stake_value', marketId: MARKET_ID, side, amountCode }) as const;

export const stakeStepAction = (side: 'back' | 'doubt', amountCode: 1 | 2 | 5 | 10) =>
  ({ t: 'stake_step', marketId: MARKET_ID, side, amountCode }) as const;

export const stakeBackAction = () => ({ t: 'stake_back', marketId: MARKET_ID }) as const;

export const INPLAY_CUTOFF = TUNABLES.INPLAY_STAKE_CUTOFF_MINUTE;
