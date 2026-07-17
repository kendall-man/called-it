import { describe, expect, it } from 'vitest';
import type { Bot } from 'grammy';
import type { HandlerCtx } from './context.js';
import type { FixtureRow, GroupRow, MarketRow } from '../ports.js';
import { renderFallback } from './copy.js';
import { registerCommands } from './commands.js';

const GROUP_ID = -100_777;
const ADMIN_ID = 700;
const NOW_MS = Date.parse('2026-07-13T10:00:00.000Z');
const BLOCKING_MARKET_ID = '0f14d0ab-9605-4a62-a9e4-5ed26688389b';
const BLOCKING_CLAIM_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';

const STANDARD_FINAL: FixtureRow = {
  fixture_id: 18_209_181,
  p1_name: 'France',
  p2_name: 'Morocco',
  kickoff_at: '2026-07-09T20:00:00.000Z',
  phase: 'F',
  minute: 90,
  last_seq: 1_113,
  score: { p1: { goals: 2 }, p2: { goals: 0 } },
  coverage_unreliable: false,
};

const NEWER_EXTRA_TIME_FINAL: FixtureRow = {
  ...STANDARD_FINAL,
  fixture_id: 18_222_446,
  p1_name: 'Argentina',
  p2_name: 'Switzerland',
  kickoff_at: '2026-07-12T01:00:00.000Z',
  phase: 'FET',
  minute: 120,
};

function makeHarness(options: {
  allowed?: boolean;
  admin?: boolean;
  startResult?: 'started' | 'already_active' | 'live_markets';
  blockingPositions?: Array<{ state: 'pending' | 'active' | 'void' }>;
  network?: 'devnet' | 'mainnet-beta';
  custodyMode?: 'legacy' | 'escrow';
  replaySpeed?: number;
} = {}) {
  const handlers = new Map<string, (ctx: any) => Promise<unknown>>();
  const posts: string[] = [];
  const starts: FixtureRow[] = [];
  const replaySpeeds: number[] = [];
  const operations: string[] = [];
  const postOptions: Array<Record<string, unknown>> = [];
  const group: GroupRow = {
    id: GROUP_ID,
    title: 'Test Group',
    slug: 'test-group',
    web_enabled: true,
    chattiness: 'trigger_only',
    is_admin: true,
  };
  const blockingMarket = {
    id: BLOCKING_MARKET_ID,
    claim_id: BLOCKING_CLAIM_ID,
    group_id: GROUP_ID,
    fixture_id: 18_237_038,
    status: 'open',
    is_replay: false,
    currency: 'sol',
  } as unknown as MarketRow;
  const bot = {
    command(name: string, handler: (ctx: any) => Promise<unknown>) {
      handlers.set(name, handler);
    },
  } as unknown as Bot;
  const h = {
    deps: {
      db: {
        async upsertGroup() { operations.push('upsert_group'); return group; },
        async upsertUser() { operations.push('upsert_user'); },
        async ensureMembership() { operations.push('membership'); },
        async fixturesBetween() {
          operations.push('fixtures_between');
          return [STANDARD_FINAL, NEWER_EXTRA_TIME_FINAL];
        },
        async getFixture(fixtureId: number) {
          operations.push(`fixture:${fixtureId}`);
          return fixtureId === STANDARD_FINAL.fixture_id ? STANDARD_FINAL : null;
        },
        async openMarketsForGroup() {
          operations.push('open_markets');
          return options.startResult === 'live_markets' ? [blockingMarket] : [];
        },
        async getClaim() {
          operations.push('get_claim');
          return { quoted_text: 'Spain will win against France' };
        },
        async positionsForMarket() {
          operations.push('positions');
          return options.blockingPositions ?? [];
        },
      },
      env: {
        WEB_BASE_URL: 'https://calledit.example',
        DEPLOYMENT_ENV: 'production',
        BETA_ALLOWED_GROUP_IDS: options.allowed === false ? [] : [GROUP_ID],
        SOLANA_NETWORK: options.network ?? 'devnet',
        WAGER_CUSTODY_MODE: options.custodyMode ?? 'legacy',
        CALLEDIT_REPLAY_SPEED: options.replaySpeed ?? 20,
      },
      log: { info() {}, warn() {}, error() {}, child() { return this; } },
      now: () => NOW_MS,
    },
    poster: {
      post(_chatId: number, text: string, postOption: Record<string, unknown> = {}) {
        posts.push(text);
        postOptions.push(postOption);
      },
    },
    say: async (key: Parameters<typeof renderFallback>[0], vars = {}) =>
      renderFallback(key, vars, options.network ?? 'devnet'),
    supervisor: {
      hasActiveReplay: () => false,
      async startReplay(_groupId: number, fixture: FixtureRow, speed: number) {
        starts.push(fixture);
        replaySpeeds.push(speed);
        return options.startResult ?? 'started';
      },
    },
  } as unknown as HandlerCtx;
  registerCommands(bot, h);

  return {
    operations,
    postOptions,
    posts,
    starts,
    replaySpeeds,
    async run(match = '') {
      const handler = handlers.get('testmatch');
      if (handler === undefined) throw new Error('testmatch handler was not registered');
      await handler({
        chat: { id: GROUP_ID, type: 'supergroup', title: 'Test Group' },
        from: { id: ADMIN_ID, is_bot: false, first_name: 'Alice' },
        message: { message_id: 44 },
        match,
        getChatMember: async () => ({
          status: options.admin === false ? 'member' : 'administrator',
        }),
      });
    },
  };
}

describe('/testmatch', () => {
  it('lets an allowlisted group admin run the isolated test flow on mainnet', async () => {
    const harness = makeHarness({ network: 'mainnet-beta' });

    await harness.run();

    expect(harness.starts).toEqual([STANDARD_FINAL]);
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]).toContain('TEST MATCH: France vs Morocco');
    expect(harness.posts[0]).toContain('Positions use real mainnet SOL and require confirmation.');
    expect(harness.posts[0]).toContain('Test results do not change Points.');
    expect(harness.operations).toEqual([
      'upsert_group', 'upsert_user', 'membership', 'fixtures_between',
    ]);
  });

  it('lets an allowlisted group admin start the latest standard completed match', async () => {
    const harness = makeHarness({ replaySpeed: 8 });

    await harness.run();

    expect(harness.starts).toEqual([STANDARD_FINAL]);
    expect(harness.replaySpeeds).toEqual([8]);
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]).toContain('TEST MATCH: France vs Morocco');
    expect(harness.posts[0]).toContain('8x speed');
    expect(harness.posts[0]).toContain('No test SOL moves');
    expect(harness.posts[0]).toContain('test results do not change Points.');
    expect(harness.operations).toEqual([
      'upsert_group', 'upsert_user', 'membership', 'fixtures_between',
    ]);
  });

  it('labels an escrow mainnet run as a signed capped completed-match replay', async () => {
    const harness = makeHarness({ network: 'mainnet-beta', custodyMode: 'escrow' });

    await harness.run();

    expect(harness.posts[0]).toContain('COMPLETED-MATCH REPLAY');
    expect(harness.posts[0]).toContain('allowlisted, capped mainnet SOL or canonical USDC');
    expect(harness.posts[0]).toContain('private Privy approval');
    expect(harness.posts[0]).toContain('Replay results do not change Points.');
    expect(harness.posts[0]).not.toContain('No SOL or USDC moves');
  });

  it('rejects non-admins and remains silent outside the beta allowlist', async () => {
    const nonAdmin = makeHarness({ admin: false });
    await nonAdmin.run();
    expect(nonAdmin.starts).toEqual([]);
    expect(nonAdmin.posts).toEqual([renderFallback('admin_only')]);

    const disallowed = makeHarness({ allowed: false });
    await disallowed.run();
    expect(disallowed.starts).toEqual([]);
    expect(disallowed.posts).toEqual([]);
    expect(disallowed.operations).toEqual([]);
  });

  it('does not start while a real group call is open', async () => {
    const harness = makeHarness({ startResult: 'live_markets' });

    await harness.run();

    expect(harness.posts[0]).toContain('Spain will win against France');
    expect(harness.posts[0]).toContain('An admin can void it below.');
    expect(JSON.stringify(harness.postOptions[0])).toContain('Void call');
    expect(JSON.stringify(harness.postOptions[0])).toContain(`vr:${BLOCKING_MARKET_ID}`);
  });

  it('names a blocking call with positions without offering a void action', async () => {
    const harness = makeHarness({
      startResult: 'live_markets',
      blockingPositions: [{ state: 'active' }],
    });

    await harness.run();

    expect(harness.posts[0]).toContain('Spain will win against France');
    expect(harness.posts[0]).toContain('must settle normally');
    expect(JSON.stringify(harness.postOptions[0])).not.toContain('Void call');
  });
});
