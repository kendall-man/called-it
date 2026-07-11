import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import type { MarketSpec } from '@calledit/market-engine';
import { registerDetection } from './detection.js';
import { renderFallback } from './copy.js';
import type { HandlerCtx } from './context.js';
import type { ClaimRow, Deps, FixtureRow, GroupRow, MarketRow } from '../ports.js';
import { LlmBudget } from './budget.js';

const NOW = Date.parse('2026-07-11T00:00:00.000Z');
const CHAT_ID = -100321;
const AUTHOR_ID = 701;
const CLAIM_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const MARKET_ID = '0f14d0ab-9605-4a62-a9e4-5ed26688389b';

const GROUP: GroupRow = {
  id: CHAT_ID,
  title: 'Direct calls',
  slug: 'direct-calls',
  web_enabled: true,
  chattiness: 'nudge',
  is_admin: true,
};

const FIXTURE: FixtureRow = {
  fixture_id: 11,
  p1_name: 'Brazil',
  p2_name: 'Norway',
  kickoff_at: new Date(NOW + 60 * 60_000).toISOString(),
  phase: 'NS',
  minute: null,
  last_seq: 0,
  score: {},
  coverage_unreliable: false,
};

const SPEC: MarketSpec = {
  claimType: 'match_winner',
  fixtureId: FIXTURE.fixture_id,
  entityRef: { kind: 'team', participant: 1, name: 'Brazil' },
  comparator: 'gte',
  threshold: 1,
  period: 'FT_90',
  trustTier: 'oracle_resolved',
};

interface DetectionHarness {
  readonly bot: Bot;
  readonly claims: ClaimRow[];
  readonly markets: MarketRow[];
  readonly posts: string[];
}

function messageUpdate(
  text: string,
  updateId: number,
  fromId = AUTHOR_ID,
  replyAuthorId?: number,
): Update {
  const replyToMessage =
    replyAuthorId === undefined
      ? {}
      : {
          reply_to_message: {
            message_id: 999,
            date: 0,
            chat: { id: CHAT_ID, type: 'group', title: GROUP.title },
            from: { id: replyAuthorId, is_bot: false, first_name: 'Dee' },
            text: 'Brazil win this',
          },
        };
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: CHAT_ID, type: 'group', title: GROUP.title },
      from: { id: fromId, is_bot: false, first_name: 'Dee' },
      text,
      ...replyToMessage,
    },
  } as unknown as Update;
}

function makeHarness(): DetectionHarness {
  const claims: ClaimRow[] = [];
  const markets: MarketRow[] = [];
  const posts: string[] = [];
  const db = {
    upsertGroup: async () => GROUP,
    upsertUser: async () => undefined,
    ensureMembership: async () => ({ created: false }),
    entityNames: async () => ({ teamNames: ['Brazil'], playerNames: [] }),
    insertClaim: async (input: Omit<ClaimRow, 'id' | 'parse' | 'created_at'>) => {
      const claim: ClaimRow = {
        ...input,
        id: CLAIM_ID,
        parse: null,
        created_at: new Date(NOW).toISOString(),
      };
      claims.push(claim);
      return claim;
    },
    getClaim: async (id: string) => claims.find((claim) => claim.id === id) ?? null,
    updateClaim: async (id: string, patch: Partial<ClaimRow>) => {
      const claim = claims.find((candidate) => candidate.id === id);
      if (claim) Object.assign(claim, patch);
    },
    getGroup: async () => GROUP,
    getUser: async (id: number) => ({ id, display_name: 'Dee', username: 'dee' }),
    getFixture: async () => FIXTURE,
    playersForFixture: async () => [],
    openMarketsForGroup: async () => markets,
    insertMarket: async (input: Omit<MarketRow, 'id' | 'card_tg_message_id' | 'created_at'>) => {
      const market: MarketRow = {
        ...input,
        id: MARKET_ID,
        card_tg_message_id: null,
        created_at: new Date(NOW).toISOString(),
      };
      markets.push(market);
      return market;
    },
    positionsForMarket: async () => [],
    setMarketCardMessage: async () => undefined,
  };
  const deps = {
    db,
    agent: {
      prefilter: () => true,
      classify: async () => ({ isClaim: true, confidence: 0.95, claimTypeGuess: 'match_winner' }),
      parse: async () => ({
        claimType: 'match_winner' as const,
        fixtureId: FIXTURE.fixture_id,
        entityName: 'Brazil',
        entityKind: 'team' as const,
        comparator: 'gte' as const,
        threshold: 1,
        period: 'FT_90' as const,
        unresolved: null,
      }),
    },
    engine: {
      compileClaim: () => ({ kind: 'ok' as const, spec: SPEC }),
      priceSpec: () => ({
        probability: 0.6,
        multiplier: 1.6,
        provenance: 'market' as const,
        oddsMessageId: 'odds-1',
        oddsTsMs: NOW,
      }),
    },
    tx: {
      fetchOdds: async () => ({
        kind: 'ok' as const,
        odds: {
          p1x2: { home: 0.6, draw: 0.25, away: 0.15 },
          totals: { line: 2.5, overProb: 0.55 },
          oddsMessageId: 'odds-1',
          oddsTsMs: NOW,
        },
      }),
    },
    wager: {
      currencyForMint: async () => 'sol' as const,
      cardFooter: () => '',
    },
    proofSubmitter: null,
    readiness: {},
    drains: [],
    env: {
      WEB_BASE_URL: 'https://web.test',
      DEPLOYMENT_ENV: 'development',
      BETA_ALLOWED_GROUP_IDS: [],
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => NOW,
  } as unknown as Deps;
  const h = {
    deps,
    poster: {
      post: (_chatId: number, text: string) => {
        posts.push(text);
      },
      editCard: () => undefined,
      stripKeyboard: () => undefined,
    },
    say: async (key: Parameters<typeof renderFallback>[0], vars = {}) => renderFallback(key, vars),
    supervisor: { replayFixture: () => null },
    entities: { get: async () => ({ teamNames: ['Brazil'], playerNames: [] }) },
    budget: new LlmBudget(100, () => NOW),
  } as unknown as HandlerCtx;
  const bot = new Bot('123:token', {
    botInfo: {
      id: 123,
      is_bot: true,
      first_name: 'Called It',
      username: 'calleditbot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
  registerDetection(bot, h);
  return { bot, claims, markets, posts };
}

describe('grammY detection consent', () => {
  it('mints an authored @bot claim directly', async () => {
    const harness = makeHarness();

    await harness.bot.handleUpdate(messageUpdate('@calleditbot Brazil win this', 1));

    expect(harness.claims).toHaveLength(1);
    expect(harness.claims[0]?.status).toBe('confirmed');
    expect(harness.markets).toHaveLength(1);
  });

  it('stores a passive detection as awaiting confirmation without a market or public quote', async () => {
    const harness = makeHarness();

    await harness.bot.handleUpdate(messageUpdate('Brazil win this', 2));

    expect(harness.claims).toHaveLength(1);
    expect(harness.claims[0]).toMatchObject({ status: 'awaiting_confirm' });
    expect(harness.claims[0]?.expires_at).toBe(new Date(NOW + 120_000).toISOString());
    expect(harness.markets).toHaveLength(0);
    expect(harness.posts.join('\n')).not.toContain('Brazil win this');
  });

  it('keeps a different member’s book-it reply behind the quoted author’s confirmation', async () => {
    const harness = makeHarness();

    await harness.bot.handleUpdate(messageUpdate('book it', 3, AUTHOR_ID + 1, AUTHOR_ID));

    expect(harness.claims).toHaveLength(1);
    expect(harness.claims[0]).toMatchObject({
      claimer_user_id: AUTHOR_ID,
      status: 'awaiting_confirm',
    });
    expect(harness.markets).toHaveLength(0);
  });
});
