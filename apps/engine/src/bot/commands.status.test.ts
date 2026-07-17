import { describe, expect, it } from 'vitest';
import type { Bot } from 'grammy';
import type { HandlerCtx } from './context.js';
import type { FixtureRow, GroupRow } from '../ports.js';
import { renderFallback } from './copy.js';
import { registerCommands } from './commands.js';

const GROUP_ID = -100_778;
const ADMIN_ID = 701;

const REPLAY_SNAPSHOT: FixtureRow = {
  fixture_id: 18_209_181,
  p1_name: 'France',
  p2_name: 'Morocco',
  kickoff_at: '2026-07-09T20:00:00.000Z',
  phase: 'H1',
  minute: 34,
  last_seq: 210,
  score: { p1: { goals: 1 }, p2: { goals: 0 } },
  coverage_unreliable: false,
};

function makeHarness(options: {
  allowed?: boolean;
  admin?: boolean;
  replay?: boolean;
  escrowReasons?: readonly string[] | 'ready' | 'throws';
  positionStates?: ReadonlyArray<'pending' | 'active' | 'void'>;
  openMarketCount?: number;
} = {}) {
  const handlers = new Map<string, (ctx: unknown) => Promise<unknown>>();
  const posts: string[] = [];
  const group: GroupRow = {
    id: GROUP_ID,
    title: 'Status Group',
    slug: 'status-group',
    web_enabled: true,
    chattiness: 'nudge',
    is_admin: true,
  };
  const openMarketCount = options.openMarketCount ?? 2;
  const bot = {
    command(name: string, handler: (ctx: unknown) => Promise<unknown>) {
      handlers.set(name, handler);
    },
  } as unknown as Bot;
  const h = {
    deps: {
      db: {
        async upsertGroup() { return group; },
        async upsertUser() {},
        async ensureMembership() {},
        async openMarketsForGroup() {
          return Array.from({ length: openMarketCount }, (_, index) => ({
            id: `market-${index}`,
          }));
        },
        async positionsForMarket(marketId: string) {
          if (marketId !== 'market-0') return [];
          return (options.positionStates ?? ['pending', 'active', 'pending']).map(
            (state, index) => ({ id: `position-${index}`, state }),
          );
        },
      },
      env: {
        WEB_BASE_URL: 'https://calledit.example',
        DEPLOYMENT_ENV: 'production',
        BETA_ALLOWED_GROUP_IDS: options.allowed === false ? [] : [GROUP_ID],
        SOLANA_NETWORK: 'devnet',
        WAGER_CUSTODY_MODE: 'escrow',
      },
      log: { info() {}, warn() {}, error() {} },
      now: () => Date.parse('2026-07-18T10:00:00.000Z'),
    },
    poster: {
      post(_chatId: number, text: string) {
        posts.push(text);
      },
    },
    say: async (key: Parameters<typeof renderFallback>[0], vars = {}) =>
      renderFallback(key, vars),
    supervisor: {
      hasActiveReplay: () => options.replay ?? false,
      replaySnapshot: () => (options.replay === true ? REPLAY_SNAPSHOT : null),
    },
    ...(options.escrowReasons === undefined ? {} : {
      status: {
        escrowReadiness: async () => {
          if (options.escrowReasons === 'throws') throw new Error('probe down');
          return options.escrowReasons === 'ready'
            ? { status: 'ready' as const, reasons: [] }
            : { status: 'not_ready' as const, reasons: options.escrowReasons ?? [] };
        },
      },
    }),
  } as unknown as HandlerCtx;
  registerCommands(bot, h);

  return {
    posts,
    async run() {
      const handler = handlers.get('status');
      if (handler === undefined) throw new Error('status handler was not registered');
      await handler({
        chat: { id: GROUP_ID, type: 'supergroup', title: 'Status Group' },
        from: { id: ADMIN_ID, is_bot: false, first_name: 'Alice' },
        message: { message_id: 12 },
        getChatMember: async () => ({
          status: options.admin === false ? 'member' : 'administrator',
        }),
      });
    },
  };
}

describe('/status', () => {
  it('posts the compact live board to an allowlisted admin', async () => {
    const harness = makeHarness({ escrowReasons: 'ready' });

    await harness.run();

    expect(harness.posts).toHaveLength(1);
    const board = harness.posts[0] ?? '';
    expect(board).toContain('📟 STATUS');
    expect(board).toContain('📡 Feed: live matches');
    expect(board).toContain('🎙 Open calls here: 2');
    expect(board).toContain('⏳ Positions in the fair-play wait: 2');
    expect(board).toContain('🔐 Escrow desk: all clear');
    // Voice rule: routine boards carry no devnet value disclaimer.
    expect(board).not.toMatch(/monetary value|\(devnet\)/);
  });

  it('shows the replay fixture and its virtual minute while a replay runs', async () => {
    const harness = makeHarness({ replay: true, escrowReasons: 'ready' });

    await harness.run();

    expect(harness.posts[0]).toContain(
      '📡 Feed: completed-match replay of France vs Morocco · minute 34',
    );
  });

  it('translates readiness reasons and never leaks the raw codes', async () => {
    const harness = makeHarness({ escrowReasons: ['indexer_lagging'] });

    await harness.run();

    expect(harness.posts[0]).toContain('🔐 Escrow desk: receipts catching up');
    expect(harness.posts[0]).not.toContain('indexer_lagging');
  });

  it('degrades gracefully when the readiness probe itself fails', async () => {
    const harness = makeHarness({ escrowReasons: 'throws' });

    await harness.run();

    expect(harness.posts[0]).toContain('🔐 Escrow desk: catching up');
  });

  it('refuses non-admins and stays silent outside the beta allowlist', async () => {
    const nonAdmin = makeHarness({ admin: false });
    await nonAdmin.run();
    expect(nonAdmin.posts).toEqual([renderFallback('admin_only')]);

    const disallowed = makeHarness({ allowed: false });
    await disallowed.run();
    expect(disallowed.posts).toEqual([]);
  });
});
