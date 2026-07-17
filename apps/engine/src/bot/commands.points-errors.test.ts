import { describe, expect, it } from 'vitest';
import type { User } from 'grammy/types';
import { renderFallback } from './copy.js';
import {
  registerNavigationCommands,
  type NavigationCommandBot,
  type NavigationCommandContext,
  type NavigationHandlerCtx,
} from './commands.js';

const GROUP_A = -100_123;
const GROUP_B = -100_456;
const RAW_ERROR_MARKER = 'postgres://secret@foreign-group';
const FOREIGN_GROUP_MEMBER = 'Private Group Member';
const RECOVERY_TEXT = 'Points are temporarily unavailable. Try again shortly.';

type PointsCommand = 'leaderboard' | 'table' | 'mystats';
type FailurePoint = 'upsert_group' | 'refresh_member' | 'stats' | 'leaderboard';
type FailureCase = {
  readonly command: PointsCommand;
  readonly failure: FailurePoint;
  readonly operation: string;
};
type Post = {
  readonly chatId: number;
  readonly text: string;
  readonly hasKeyboard: boolean;
};

const FAILURE_CASES = [
  { command: 'leaderboard', failure: 'upsert_group', operation: 'upsert_group' },
  { command: 'leaderboard', failure: 'leaderboard', operation: 'leaderboard' },
  { command: 'table', failure: 'upsert_group', operation: 'upsert_group' },
  { command: 'table', failure: 'leaderboard', operation: 'leaderboard' },
  { command: 'mystats', failure: 'refresh_member', operation: 'refresh_member' },
  { command: 'mystats', failure: 'stats', operation: 'stats' },
  { command: 'mystats', failure: 'leaderboard', operation: 'leaderboard' },
] as const satisfies readonly FailureCase[];

class DependencyProbeError extends Error {
  readonly name = 'DependencyProbeError';

  constructor(readonly failure: FailurePoint) {
    super(
      `${RAW_ERROR_MARKER}; failure=${failure}; group=${GROUP_B}; member=${FOREIGN_GROUP_MEMBER}`,
    );
  }
}

class MissingCommandError extends Error {
  readonly name = 'MissingCommandError';

  constructor(readonly command: string) {
    super(`Missing command handler: ${command}`);
  }
}

function sender(): User {
  return { id: 700, is_bot: false, first_name: 'Alice', username: 'alice_calls' };
}

function commandContext(): NavigationCommandContext {
  return {
    chat: { id: GROUP_A, type: 'supergroup', title: 'Sunday Legends' },
    me: { username: 'calledit_bot' },
    from: sender(),
  };
}

function failAt(active: FailurePoint, current: FailurePoint): void {
  if (active === current) throw new DependencyProbeError(current);
}

function errorHarness(activeFailure: FailurePoint) {
  const handlers = new Map<string, (ctx: NavigationCommandContext) => Promise<unknown>>();
  const posts: Post[] = [];
  const operations: string[] = [];
  const bot: NavigationCommandBot = {
    command(name, handler) {
      handlers.set(name, handler);
    },
  };
  const h: NavigationHandlerCtx = {
    deps: {
      db: {
        async upsertGroup(input) {
          operations.push('upsert_group');
          failAt(activeFailure, 'upsert_group');
          return {
            id: input.id,
            title: input.title,
            slug: 'sunday-legends',
            web_enabled: true,
            chattiness: 'nudge',
            is_admin: true,
          };
        },
        async markGroupReady() {
          return {
            ok: true,
            created: true,
            groupId: GROUP_A,
            onboardingVersion: 'calledit_v1',
          };
        },
        async leaderboard(groupId) {
          operations.push('leaderboard');
          failAt(activeFailure, 'leaderboard');
          return [{
            group_id: groupId,
            user_id: 700,
            display_name: FOREIGN_GROUP_MEMBER,
            username: null,
            points: 20,
            wins: 2,
            losses: 0,
            accuracy: 1,
            current_streak: 2,
            best_streak: 2,
          }];
        },
        async groupPlayerStats(groupId, userId) {
          operations.push('stats');
          failAt(activeFailure, 'stats');
          return {
            group_id: groupId,
            user_id: userId,
            points: 20,
            wins: 2,
            losses: 0,
            accuracy: 1,
            current_streak: 2,
            best_streak: 2,
          };
        },
      },
      env: {
        WEB_BASE_URL: 'https://calledit.example/',
        DEPLOYMENT_ENV: 'production',
        BETA_ALLOWED_GROUP_IDS: [GROUP_A],
      },
    },
    poster: {
      post(chatId, text, options) {
        posts.push({ chatId, text, hasKeyboard: options?.keyboard !== undefined });
      },
    },
    say: async (key, vars) => renderFallback(key, vars),
    async refreshMember() {
      operations.push('refresh_member');
      failAt(activeFailure, 'refresh_member');
    },
  };
  registerNavigationCommands(bot, h);
  return {
    operations,
    posts,
    async call(command: string): Promise<void> {
      const handler = handlers.get(command);
      if (handler === undefined) throw new MissingCommandError(command);
      await handler(commandContext());
    },
  };
}

describe('group points command dependency recovery', () => {
  it.each(FAILURE_CASES)(
    'redacts $failure failures for /$command',
    async ({ command, failure, operation }) => {
      // Given one allowlisted group and a dependency failure carrying foreign-group secrets
      const harness = errorHarness(failure);

      // When the member invokes the affected points command
      await harness.call(command);

      // Then only the fixed recovery reaches the invoking group
      expect(harness.operations).toContain(operation);
      expect(harness.posts).toEqual([
        { chatId: GROUP_A, text: RECOVERY_TEXT, hasKeyboard: false },
      ]);
      const serializedPosts = JSON.stringify(harness.posts);
      expect(serializedPosts).not.toContain(RAW_ERROR_MARKER);
      expect(serializedPosts).not.toContain(FOREIGN_GROUP_MEMBER);
      expect(serializedPosts).not.toContain(String(GROUP_B));
    },
  );

  it('keeps unrelated help available after a recovered dependency failure', async () => {
    // Given a recovered leaderboard failure
    const harness = errorHarness('leaderboard');
    await harness.call('leaderboard');

    // When the same chat invokes an unrelated command
    await harness.call('help');

    // Then help still posts after the deterministic recovery
    expect(harness.posts).toEqual([
      { chatId: GROUP_A, text: RECOVERY_TEXT, hasKeyboard: false },
      { chatId: GROUP_A, text: renderFallback('help'), hasKeyboard: false },
    ]);
  });
});
