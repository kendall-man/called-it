import { describe, expect, it } from 'vitest';
import {
  bookitConsent,
  registerNavigationCommands,
  type NavigationCommandBot,
  type NavigationCommandContext,
  type NavigationHandlerCtx,
} from './commands.js';

type Post = {
  readonly chatId: number;
  readonly text: string;
  readonly keyboardUrls: readonly string[];
};

function privateContext(): NavigationCommandContext {
  return {
    chat: { id: 300, type: 'private' },
    me: { username: 'calledit_bot' },
  };
}

function groupContext(): NavigationCommandContext {
  return {
    chat: { id: -100123, type: 'supergroup', title: 'Sunday Legends' },
    me: { username: 'calledit_bot' },
  };
}

describe('navigation commands', () => {
  it('keeps private start and group navigation free of wallet entry points', async () => {
    // Given the navigation handlers and one private and one group context
    const handlers = new Map<string, (ctx: NavigationCommandContext) => Promise<unknown>>();
    const posts: Post[] = [];
    const bot: NavigationCommandBot = {
      command(name, handler) {
        handlers.set(name, handler);
      },
    };
    const ctx: NavigationHandlerCtx = {
      deps: {
        db: {
          async upsertGroup(input) {
            return {
              id: input.id,
              slug: 'group / ?',
              title: input.title,
              web_enabled: true,
              chattiness: 'nudge',
              is_admin: true,
            };
          },
          async markGroupReady() {
            return { ok: true, created: true, groupId: -100123, onboardingVersion: 'calledit_v1' };
          },
        },
        env: {
          WEB_BASE_URL: 'https://calledit.example/',
          DEPLOYMENT_ENV: 'development',
          BETA_ALLOWED_GROUP_IDS: [],
        },
      },
      poster: {
        post(chatId, text, options) {
          const keyboardUrls = options?.keyboard?.inline_keyboard.flatMap((row) =>
            row.flatMap((button) => ('url' in button && button.url !== undefined ? [button.url] : [])),
          ) ?? [];
          posts.push({
            chatId,
            text,
            keyboardUrls,
          });
        },
      },
      async say(key) {
        if (key === 'help') return 'Help recovery';
        if (key === 'private_start') {
          return 'Called It lives in group chats. Add it to a group.';
        }
        if (key === 'table_link') return 'Open the group board.';
        return `unexpected copy key: ${key}`;
      },
    };
    registerNavigationCommands(bot, ctx);
    const call = async (name: string, commandCtx: NavigationCommandContext): Promise<void> => {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`missing ${name} handler`);
      await handler(commandCtx);
    };

    // When private start and group /table are invoked
    await call('start', privateContext());
    await call('table', groupContext());

    // Then private start exposes only the group-add action and the board path
    // encodes the stored group slug.
    expect(posts).toEqual([
      {
        chatId: 300,
        text: 'Called It lives in group chats. Add it to a group.',
        keyboardUrls: ['https://t.me/calledit_bot?startgroup=calledit_v1'],
      },
      {
        chatId: -100123,
        text: 'Open the group board.',
        keyboardUrls: ['https://calledit.example/g/group%20%2F%20%3F'],
      },
    ]);
    expect(JSON.stringify(posts)).not.toMatch(/balance|wallet:|[1-9A-HJ-NP-Za-km-z]{32,}/i);
  });

  it('makes /bookit explicit only for the replied-to speaker', () => {
    // Given the command sender and the original claim author
    const ownerId = 700;

    // When the sender is the author or another group member
    const ownerConsent = bookitConsent(ownerId, ownerId);
    const friendConsent = bookitConsent(701, ownerId);

    // Then a friend cannot publish terms or a quote before the owner confirms
    expect(ownerConsent).toBe('explicit');
    expect(friendConsent).toBe('awaiting_confirm');
  });
});
