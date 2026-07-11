import { describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '../log.js';
import {
  GROUP_BOT_COMMANDS,
  PRIVATE_BOT_COMMANDS,
  configureScopedBotCommands,
  registerGroupLifecycleHandlers,
  registerBotErrorHandler,
  type BotErrorRegistrar,
  type BotCommandScopeApi,
  type GroupLifecycleBot,
  type GroupLifecycleHandlerCtx,
} from './bot.js';

type ErrorLog = {
  readonly event: string;
  readonly fields: LogFields | undefined;
};

class CatchHarness implements BotErrorRegistrar {
  private handler: ((error: { readonly error: unknown }) => unknown) | undefined;

  catch(handler: (error: { readonly error: unknown }) => unknown): void {
    this.handler = handler;
  }

  trigger(error: unknown): void {
    const handler = this.handler;
    if (handler === undefined) throw new Error('catch handler not registered');
    handler({ error });
  }
}

function makeLogger(logs: ErrorLog[]): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: (event, fields) => logs.push({ event, fields }),
    child: () => makeLogger(logs),
  };
}

describe('bot error boundary', () => {
  it('redacts secret-bearing handler errors before structured logging', () => {
    // Given a registered bot catcher and an exception containing credential material
    const logs: ErrorLog[] = [];
    const bot = new CatchHarness();
    registerBotErrorHandler(bot, makeLogger(logs));
    const secret = 'Bearer route-credential initData wallet-private-key';

    // When grammY reports the raw handler exception
    bot.trigger(new Error(secret));

    // Then the log contains only a stable reason and no exception text
    expect(logs).toEqual([
      { event: 'bot_update_failed', fields: { reason: 'bot_handler_exception' } },
    ]);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });
});

describe('onboarding scopes and lifecycle', () => {
  it('installs the exact private and group command menus', async () => {
    // Given a Bot API recorder
    const calls: Array<{ readonly commands: readonly { readonly command: string }[]; readonly scope: string }> = [];
    const api: BotCommandScopeApi = {
      async setMyCommands(commands, options) {
        calls.push({ commands, scope: options.scope.type });
      },
    };

    // When the scoped command configuration is applied
    await configureScopedBotCommands(api);

    // Then each chat scope receives only its intended commands
    expect(calls).toEqual([
      { commands: PRIVATE_BOT_COMMANDS, scope: 'all_private_chats' },
      { commands: GROUP_BOT_COMMANDS, scope: 'all_group_chats' },
    ]);
    expect(PRIVATE_BOT_COMMANDS.map((command) => command.command)).toEqual(['start', 'help']);
    expect(GROUP_BOT_COMMANDS.map((command) => command.command)).toEqual([
      'bookit',
      'leaderboard',
      'mystats',
      'table',
      'help',
    ]);
  });

  it('posts one ready message across group start and admin lifecycle updates', async () => {
    // Given an in-memory grammY lifecycle seam and a marker that accepts only its first claim
    let handler: ((ctx: Parameters<GroupLifecycleBot['on']>[1] extends (ctx: infer Ctx) => unknown ? Ctx : never) => Promise<unknown>) | undefined;
    let markerCalls = 0;
    const posts: string[] = [];
    const bot: GroupLifecycleBot = {
      on(_filter, registered) {
        handler = registered;
      },
    };
    const h: GroupLifecycleHandlerCtx = {
      deps: {
        db: {
          async upsertGroup(input) {
            return {
              id: input.id,
              title: input.title,
              slug: 'sunday-legends',
              web_enabled: true,
              chattiness: 'nudge',
              is_admin: true,
            };
          },
          async setGroupAdmin() {},
          async markGroupReady() {
            markerCalls += 1;
            return {
              ok: true,
              created: markerCalls === 1,
              groupId: -100123,
              onboardingVersion: 'calledit_v1',
            };
          },
        },
        env: {
          WEB_BASE_URL: 'https://calledit.example',
          DEPLOYMENT_ENV: 'development',
          BETA_ALLOWED_GROUP_IDS: [],
        },
        log: makeLogger([]),
      },
      poster: {
        post(_chatId, text) {
          posts.push(text);
        },
      },
    };
    registerGroupLifecycleHandlers(bot, h);
    const lifecycle = handler;
    if (lifecycle === undefined) throw new Error('group lifecycle handler not registered');
    const groupStart = {
      chat: { id: -100123, type: 'supergroup', title: 'Sunday Legends' },
      myChatMember: {
        old_chat_member: { status: 'left' },
        new_chat_member: { status: 'member' },
      },
    };
    const adminUpdate = {
      chat: { id: -100123, type: 'supergroup', title: 'Sunday Legends' },
      myChatMember: {
        old_chat_member: { status: 'member' },
        new_chat_member: { status: 'administrator' },
      },
    };

    // When Telegram sends the persisted group start followed by an admin update
    await lifecycle(groupStart);
    await lifecycle(adminUpdate);

    // Then the marker is consulted twice but only one concise ready post is emitted
    expect(markerCalls).toBe(2);
    expect(posts).toEqual([
      'Called It is ready. Say a football call, mention me, or reply /bookit to your own message. Each offer has two fixed 0.01 test-SOL choices: "It happens" or "It does not." Choices and named results are visible to everyone in this Telegram group. Correct choices earn 10 points automatically. Test SOL is devnet-only with no monetary value. Board: https://calledit.example/g/sunday-legends',
    ]);
  });
});
