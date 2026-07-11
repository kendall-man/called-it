import { describe, expect, it } from 'vitest';
import type { User } from 'grammy/types';
import type { EngineDb } from '../ports.js';
import {
  registerNavigationCommands,
  type NavigationCommandBot,
  type NavigationCommandContext,
  type NavigationHandlerCtx,
} from './commands.js';

const GROUP_A = -100_123;
const GROUP_B = -100_456;

type BoardEntry = Awaited<ReturnType<EngineDb['leaderboard']>>[number];
type PlayerStats = Awaited<ReturnType<EngineDb['groupPlayerStats']>>;
type Post = {
  readonly chatId: number;
  readonly text: string;
  readonly buttons: readonly Readonly<{ text: string; url: string }>[];
};
type StatsHarnessOptions = {
  readonly board: (groupId: number, limit: number) => readonly BoardEntry[];
  readonly stats: (groupId: number, userId: number) => PlayerStats;
};

function telegramUser(overrides: Partial<User> = {}): User {
  return { id: 700, is_bot: false, first_name: 'Alice', username: 'alice_calls', ...overrides };
}

function groupContext(groupId = GROUP_A, from: User = telegramUser()): NavigationCommandContext {
  return {
    chat: { id: groupId, type: 'supergroup', title: groupId === GROUP_A ? 'Sunday Legends' : 'Second Group' },
    me: { username: 'calledit_bot' },
    from,
  };
}

function boardEntry(overrides: Partial<BoardEntry> = {}): BoardEntry {
  return {
    group_id: GROUP_A,
    user_id: 700,
    display_name: 'Alice',
    username: null,
    points: 20,
    wins: 2,
    losses: 1,
    accuracy: 2 / 3,
    current_streak: 1,
    best_streak: 2,
    ...overrides,
  };
}

function playerStats(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    group_id: GROUP_A,
    user_id: 700,
    points: 0,
    wins: 0,
    losses: 0,
    accuracy: 0,
    current_streak: 0,
    best_streak: 0,
    ...overrides,
  };
}

function statsHarness(options: StatsHarnessOptions) {
  const handlers = new Map<string, (ctx: NavigationCommandContext) => Promise<unknown>>();
  const posts: Post[] = [];
  const operations: string[] = [];
  const storedNames = new Map<number, string>([[700, 'Stale Alice']]);
  const bot: NavigationCommandBot = {
    command(name, handler) {
      handlers.set(name, handler);
    },
  };
  const h: NavigationHandlerCtx = {
    deps: {
      db: {
        async upsertGroup() {
          throw new Error('unexpected group upsert');
        },
        async markGroupReady() {
          throw new Error('unexpected group-ready write');
        },
        async leaderboard(groupId, limit) {
          operations.push(`leaderboard:${groupId}:${limit}`);
          return options.board(groupId, limit);
        },
        async groupPlayerStats(groupId, userId) {
          operations.push(`stats:${groupId}:${userId}`);
          return options.stats(groupId, userId);
        },
      },
      env: {
        WEB_BASE_URL: 'https://calledit.example/',
        DEPLOYMENT_ENV: 'production',
        BETA_ALLOWED_GROUP_IDS: [GROUP_A, GROUP_B],
      },
    },
    poster: {
      post(chatId, text, postOptions) {
        const buttons = postOptions?.keyboard?.inline_keyboard.flatMap((row) =>
          row.flatMap((button) =>
            'url' in button && button.url !== undefined ? [{ text: button.text, url: button.url }] : [],
          ),
        ) ?? [];
        posts.push({ chatId, text, buttons });
      },
    },
    async say(key) {
      return `unexpected copy key: ${key}`;
    },
    async refreshMember(input) {
      operations.push(`refresh:${input.chatId}:${input.user.id}`);
      storedNames.set(
        input.user.id,
        `${input.user.first_name}${input.user.last_name ? ` ${input.user.last_name}` : ''}`,
      );
    },
  };
  registerNavigationCommands(bot, h);
  return {
    operations,
    posts,
    storedNames,
    async call(ctx: NavigationCommandContext): Promise<void> {
      const handler = handlers.get('mystats');
      if (handler === undefined) throw new Error('missing mystats handler');
      await handler(ctx);
    },
  };
}

describe('group points stats command', () => {
  it('refreshes the sender and returns isolated rank and totals across a 101-player group', async () => {
    // Given one Telegram user with different stats and ranks in two allowlisted groups
    const boards = new Map<number, readonly BoardEntry[]>([
      [GROUP_A, [boardEntry({ user_id: 701, points: 50, wins: 5, losses: 0 }), boardEntry({ user_id: 700 })]],
      [GROUP_B, Array.from({ length: 100 }, (_, index) => boardEntry({ group_id: GROUP_B, user_id: 800 + index }))],
    ]);
    const harness = statsHarness({
      board: (groupId) => boards.get(groupId) ?? [],
      stats: (groupId, userId) => groupId === GROUP_A
        ? playerStats({ group_id: groupId, user_id: userId, points: 40, wins: 4, losses: 2, current_streak: 2, best_streak: 4 })
        : playerStats({ group_id: groupId, user_id: userId, points: 10, wins: 1, current_streak: 1, best_streak: 1 }),
    });
    const renamed = telegramUser({ first_name: 'Alice', last_name: 'Renamed', username: 'alice_new' });

    // When the same sender requests /mystats in both groups
    await harness.call(groupContext(GROUP_A, renamed));
    await harness.call(groupContext(GROUP_B, renamed));

    // Then refresh precedes each group-only read and neither group's totals leak
    expect(harness.operations).toEqual([
      `refresh:${GROUP_A}:700`, `stats:${GROUP_A}:700`, `leaderboard:${GROUP_A}:100`,
      `refresh:${GROUP_B}:700`, `stats:${GROUP_B}:700`, `leaderboard:${GROUP_B}:100`,
    ]);
    expect(harness.storedNames.get(700)).toBe('Alice Renamed');
    expect(harness.posts).toEqual([
      { chatId: GROUP_A, text: 'Your group stats\nRank: 2nd\nPoints: 40\nWins: 4\nLosses: 2\nAccuracy: 67%\nCurrent streak: 2\nBest streak: 4', buttons: [] },
      { chatId: GROUP_B, text: 'Your group stats\nRank: Outside top 100\nPoints: 10\nWins: 1\nLosses: 0\nAccuracy: 100%\nCurrent streak: 1\nBest streak: 1', buttons: [] },
    ]);
  });

  it('returns unranked zeros for an unknown member without a score-row write', async () => {
    // Given a valid sender absent from group_player_stats
    const harness = statsHarness({
      board: () => [],
      stats: (groupId, userId) => playerStats({ group_id: groupId, user_id: userId }),
    });

    // When they request /mystats
    await harness.call(groupContext());

    // Then only context refresh and read operations occur
    expect(harness.operations).toEqual([
      `refresh:${GROUP_A}:700`, `stats:${GROUP_A}:700`, `leaderboard:${GROUP_A}:100`,
    ]);
    expect(harness.posts).toEqual([
      { chatId: GROUP_A, text: 'Your group stats\nRank: Unranked\nPoints: 0\nWins: 0\nLosses: 0\nAccuracy: 0%\nCurrent streak: 0\nBest streak: 0', buttons: [] },
    ]);
  });
});
