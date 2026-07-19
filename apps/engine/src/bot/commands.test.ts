import { describe, expect, it } from 'vitest';
import type { User } from 'grammy/types';
import type { EngineDb } from '../ports.js';
import {
  bookitConsent,
  registerNavigationCommands,
  type NavigationCommandBot,
  type NavigationCommandContext,
  type NavigationHandlerCtx,
} from './commands.js';

const GROUP_A = -100_123;
const GROUP_B = -100_456;
const PRIVATE_CHAT = 300;

type BoardEntry = Awaited<ReturnType<EngineDb['leaderboard']>>[number];
type CommandContext = NavigationCommandContext;
type Post = {
  readonly chatId: number;
  readonly text: string;
  readonly buttons: readonly Readonly<{ text: string; url: string }>[];
};
type HarnessOptions = {
  readonly allowed?: readonly number[];
  readonly board?: (groupId: number, limit: number) => readonly BoardEntry[];
};

function telegramUser(overrides: Partial<User> = {}): User {
  return { id: 700, is_bot: false, first_name: 'Alice', username: 'alice_calls', ...overrides };
}

function groupContext(groupId = GROUP_A, from: User | undefined = telegramUser()): CommandContext {
  return {
    chat: { id: groupId, type: 'supergroup', title: groupId === GROUP_A ? 'Sunday Legends' : 'Second Group' },
    me: { username: 'calledit_bot' },
    from,
  };
}

function privateContext(): CommandContext {
  return { chat: { id: PRIVATE_CHAT, type: 'private' }, me: { username: 'calledit_bot' }, from: undefined };
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

function commandHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, (ctx: NavigationCommandContext) => Promise<unknown>>();
  const posts: Post[] = [];
  const operations: string[] = [];
  const bot: NavigationCommandBot = {
    command(name, handler) {
      handlers.set(name, handler);
    },
  };
  const db: NavigationHandlerCtx['deps']['db'] = {
    async upsertGroup(input: Parameters<EngineDb['upsertGroup']>[0]) {
      operations.push(`group:${input.id}`);
      return {
        id: input.id,
        title: input.title,
        slug: input.id === GROUP_A ? 'group / ?' : 'second-group',
        web_enabled: true,
        chattiness: 'nudge' as const,
        is_admin: true,
      };
    },
    async markGroupReady() {
      return { ok: true, created: true, groupId: GROUP_A, onboardingVersion: 'calledit_v1' as const };
    },
    async leaderboard(groupId: number, limit: number) {
      operations.push(`leaderboard:${groupId}:${limit}`);
      return options.board?.(groupId, limit) ?? [];
    },
    async groupPlayerStats() {
      throw new Error('unexpected stats read');
    },
  };
  const h: NavigationHandlerCtx = {
    deps: {
      db,
      env: {
        WEB_BASE_URL: 'https://calledit.example/',
        DEPLOYMENT_ENV: 'production' as const,
        BETA_ALLOWED_GROUP_IDS: [...(options.allowed ?? [GROUP_A])],
      },
    },
    poster: {
      post(...args: Parameters<NavigationHandlerCtx['poster']['post']>) {
        const [chatId, text, postOptions] = args;
        const buttons = postOptions?.keyboard?.inline_keyboard.flatMap((row) =>
          row.flatMap((button) =>
            'url' in button && button.url !== undefined ? [{ text: button.text, url: button.url }] : [],
          ),
        ) ?? [];
        posts.push({ chatId, text, buttons });
      },
    },
    async say(key) {
      if (key === 'help') return 'Help recovery';
      if (key === 'intro') return 'Private Rumble introduction';
      if (key === 'group_only_recovery') return 'Open this command in the group.';
      if (key === 'table_link') return 'Open the group board.';
      return `unexpected copy key: ${key}`;
    },
    async refreshMember(input) {
      operations.push(`refresh:${input.chatId}:${input.user.id}`);
    },
  };
  registerNavigationCommands(bot, h);
  return {
    posts,
    operations,
    async call(name: string, ctx: CommandContext): Promise<void> {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`missing ${name} handler`);
      await handler(ctx);
    },
  };
}

describe('navigation command baseline', () => {
  it('keeps private start/help and /bookit consent behavior stable', async () => {
    // Given the current private command seam and a claim author
    const harness = commandHarness();

    // When private navigation and both /bookit consent paths are evaluated
    await harness.call('start', privateContext());
    await harness.call('help', privateContext());

    // Then navigation stays narrow and only the author gets explicit consent
    expect(harness.posts).toEqual([
      {
        chatId: PRIVATE_CHAT,
        text: 'Private Rumble introduction',
        buttons: [{
          text: 'Add to group',
          url: 'https://t.me/calledit_bot?startgroup=calledit_v1&admin=manage_chat',
        }],
      },
      { chatId: PRIVATE_CHAT, text: 'Help recovery', buttons: [] },
    ]);
    expect(bookitConsent(700, 700)).toBe('explicit');
    expect(bookitConsent(701, 700)).toBe('awaiting_confirm');
  });
});

describe('group points commands', () => {
  it('posts the same deterministic top ten for /leaderboard and /table with the encoded board button', async () => {
    // Given twelve ordered players including a deterministic tie
    const board = Array.from({ length: 12 }, (_, index) => boardEntry({
      user_id: 700 + index,
      display_name: index === 0 ? 'Alice Renamed' : `Player ${index}`,
      username: index === 1 ? 'bob_calls' : null,
      points: index < 2 ? 20 : 10,
      wins: index < 2 ? 2 : 1,
      losses: 1,
    }));
    const harness = commandHarness({ board: (groupId) => board.map((entry) => ({ ...entry, group_id: groupId })) });

    // When both group board commands run
    await harness.call('leaderboard', groupContext());
    await harness.call('table', groupContext());

    // Then both posts preserve order, cap at ten, and only /table links the encoded slug
    const expectedText = [
      'Group leaderboard', '1st. Alice Renamed - 20 points, 2 wins, 1 loss, 67% accuracy',
      '2nd. @bob_calls - 20 points, 2 wins, 1 loss, 67% accuracy', '3rd. Player 2 - 10 points, 1 win, 1 loss, 50% accuracy',
      '4th. Player 3 - 10 points, 1 win, 1 loss, 50% accuracy', '5th. Player 4 - 10 points, 1 win, 1 loss, 50% accuracy',
      '6th. Player 5 - 10 points, 1 win, 1 loss, 50% accuracy', '7th. Player 6 - 10 points, 1 win, 1 loss, 50% accuracy',
      '8th. Player 7 - 10 points, 1 win, 1 loss, 50% accuracy', '9th. Player 8 - 10 points, 1 win, 1 loss, 50% accuracy',
      '10th. Player 9 - 10 points, 1 win, 1 loss, 50% accuracy',
    ].join('\n');
    expect(harness.posts).toEqual([
      { chatId: GROUP_A, text: expectedText, buttons: [] },
      { chatId: GROUP_A, text: expectedText, buttons: [{ text: 'Open group board', url: 'https://calledit.example/g/group%20%2F%20%3F' }] },
    ]);
    expect(harness.operations).toEqual([
      `group:${GROUP_A}`, `leaderboard:${GROUP_A}:10`,
      `group:${GROUP_A}`, `leaderboard:${GROUP_A}:10`,
    ]);
  });

  it('posts the no-settled-calls state for an empty allowlisted group', async () => {
    // Given an allowlisted group with no score rows
    const harness = commandHarness();

    // When its leaderboard is requested
    await harness.call('leaderboard', groupContext());

    // Then the empty presentation is posted exactly once
    expect(harness.posts).toEqual([
      { chatId: GROUP_A, text: 'Group leaderboard\nNo settled calls yet.', buttons: [] },
    ]);
  });

  it('recovers in private, stays silent when disallowed, and rejects missing or malformed senders', async () => {
    // Given one allowlisted group, one disallowed group, and invalid sender contexts
    const harness = commandHarness();

    // When every group points command is tried outside its valid context
    for (const command of ['leaderboard', 'mystats', 'table']) await harness.call(command, privateContext());
    for (const command of ['leaderboard', 'mystats', 'table']) await harness.call(command, groupContext(GROUP_B));
    await harness.call('mystats', { ...groupContext(), from: undefined });
    await harness.call('mystats', groupContext(GROUP_A, telegramUser({ id: Number.NaN })));
    await harness.call('mystats', groupContext(GROUP_A, telegramUser({ is_bot: true })));

    // Then private users get recovery, while every invalid group path is silent and read-free
    expect(harness.posts).toEqual(['leaderboard', 'mystats', 'table'].map(() => ({
      chatId: PRIVATE_CHAT,
      text: 'Open this command in the group.',
      buttons: [],
    })));
    expect(harness.operations).toEqual([]);
  });
});
