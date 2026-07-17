import { describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '../log.js';
import type { BotGroupReadyMarkerResult } from '../ports.js';
import {
  ESCROW_PRIVATE_BOT_COMMANDS,
  GROUP_BOT_COMMANDS,
  MAINNET_PRIVATE_BOT_COMMANDS,
  PRIVATE_BOT_COMMANDS,
  configureScopedBotCommands,
  registerGroupLifecycleHandlers,
  registerBotErrorHandler,
  registerWagerCommands,
  type BotErrorRegistrar,
  type BotCommandScopeApi,
  type GroupLifecycleBot,
  type GroupLifecycleContext,
  type GroupLifecycleHandlerCtx,
  type WagerCommandModule,
} from './bot.js';
import type { Bot } from 'grammy';
import type { WagerBotLike, WagerModule } from '../wager/module.js';

type RecordedLog = {
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

function makeLogger(logs: RecordedLog[]): Logger {
  return {
    info: (event, fields) => logs.push({ event, fields }),
    warn: (event, fields) => logs.push({ event, fields }),
    error: (event, fields) => logs.push({ event, fields }),
    child: () => makeLogger(logs),
  };
}

const RAW_GROUP_ID = -100987654321;
const RAW_GROUP_NAME = 'Identity Leak United';

function lifecycleUpdate(previous: string, next: string): GroupLifecycleContext {
  return {
    chat: { id: RAW_GROUP_ID, type: 'supergroup', title: RAW_GROUP_NAME },
    myChatMember: {
      old_chat_member: { status: previous },
      new_chat_member: { status: next },
    },
  };
}

function makeLifecyclePrivacyHarness(input: {
  readonly allowlisted: boolean;
  readonly marker?: BotGroupReadyMarkerResult;
}): {
  readonly logs: RecordedLog[];
  readonly deliver: (update: GroupLifecycleContext) => Promise<unknown>;
} {
  let handler: ((ctx: GroupLifecycleContext) => Promise<unknown>) | undefined;
  const logs: RecordedLog[] = [];
  const bot: GroupLifecycleBot = {
    on(_filter, registered) {
      handler = registered;
    },
  };
  const h: GroupLifecycleHandlerCtx = {
    deps: {
      db: {
        async upsertGroup(group) {
          return {
            id: group.id,
            title: group.title,
            slug: 'identity-leak-united',
            web_enabled: true,
            chattiness: 'nudge',
            is_admin: true,
          };
        },
        async setGroupAdmin() {},
        async markGroupReady() {
          return input.marker ?? {
            ok: true,
            created: false,
            groupId: RAW_GROUP_ID,
            onboardingVersion: 'calledit_v1',
          };
        },
      },
      env: {
        WEB_BASE_URL: 'https://calledit.example',
        DEPLOYMENT_ENV: 'production',
        BETA_ALLOWED_GROUP_IDS: input.allowlisted ? [RAW_GROUP_ID] : [],
      },
      log: makeLogger(logs),
    },
    poster: { post: () => undefined },
  };
  registerGroupLifecycleHandlers(bot, h);
  const lifecycle = handler;
  if (lifecycle === undefined) throw new Error('group lifecycle handler not registered');
  return { logs, deliver: lifecycle };
}

describe('bot error boundary', () => {
  it('redacts secret-bearing handler errors before structured logging', () => {
    // Given a registered bot catcher and an exception containing credential material
    const logs: RecordedLog[] = [];
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

describe('group lifecycle logging privacy', () => {
  it('omits Telegram identity from beta allowlist rejection logs', async () => {
    // Given a production group that is outside the beta allowlist
    const harness = makeLifecyclePrivacyHarness({ allowlisted: false });

    // When Telegram delivers its membership update
    await harness.deliver(lifecycleUpdate('left', 'member'));

    // Then the rejection event carries no raw group identity
    expect(harness.logs).toEqual([{ event: 'beta_group_not_allowlisted', fields: undefined }]);
    expect(JSON.stringify(harness.logs)).not.toContain(String(RAW_GROUP_ID));
    expect(JSON.stringify(harness.logs)).not.toContain(RAW_GROUP_NAME);
  });

  it('retains membership statuses without logging Telegram identity', async () => {
    // Given an allowlisted production group
    const harness = makeLifecyclePrivacyHarness({ allowlisted: true });

    // When its bot membership changes
    await harness.deliver(lifecycleUpdate('left', 'member'));

    // Then only the operational status transition is logged
    expect(harness.logs).toEqual([
      { event: 'membership_change', fields: { previous: 'left', next: 'member' } },
    ]);
    expect(JSON.stringify(harness.logs)).not.toContain(String(RAW_GROUP_ID));
    expect(JSON.stringify(harness.logs)).not.toContain(RAW_GROUP_NAME);
  });

  it('retains readiness rejection codes without logging Telegram identity', async () => {
    // Given an allowlisted group whose durable readiness marker rejects the update
    const harness = makeLifecyclePrivacyHarness({
      allowlisted: true,
      marker: { ok: false, code: 'group_not_found' },
    });

    // When Telegram delivers the membership update
    await harness.deliver(lifecycleUpdate('left', 'administrator'));

    // Then the logs retain statuses and rejection code but no raw group identity
    expect(harness.logs).toEqual([
      { event: 'membership_change', fields: { previous: 'left', next: 'administrator' } },
      { event: 'group_readiness_rejected', fields: { code: 'group_not_found' } },
    ]);
    expect(JSON.stringify(harness.logs)).not.toContain(String(RAW_GROUP_ID));
    expect(JSON.stringify(harness.logs)).not.toContain(RAW_GROUP_NAME);
  });
});

describe('onboarding scopes and lifecycle', () => {
  it('registers private account handlers for the funded runtime only', () => {
    const registrations: string[] = [];
    const bot: WagerBotLike = {
      command(command: string) {
        registrations.push(command);
      },
    };
    const funded: WagerCommandModule = {
      kind: 'funded',
      registerCommands(commandBot: { command(command: string): unknown }) {
        commandBot.command('wallet');
        commandBot.command('deposit');
        commandBot.command('withdraw');
      },
    };
    const starterOnly = { kind: 'starter_only' } as unknown as WagerModule;

    registerWagerCommands(bot, funded);
    registerWagerCommands(bot, starterOnly);
    registerWagerCommands(bot, null);

    expect(registrations).toEqual(['wallet', 'deposit', 'withdraw']);
  });

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
    expect(PRIVATE_BOT_COMMANDS.map((command) => command.command)).toEqual([
      'start', 'help', 'wallet', 'deposit', 'withdraw',
    ]);
    expect(GROUP_BOT_COMMANDS.map((command) => command.command)).toEqual([
      'bookit',
      'leaderboard',
      'mystats',
      'table',
      'settings',
      'status',
      'currency',
      'testmatch',
      'help',
    ]);
  });

  it('keeps the funded account commands identical on mainnet', async () => {
    const calls: Array<{ readonly commands: readonly { readonly command: string }[]; readonly scope: string }> = [];
    const api: BotCommandScopeApi = {
      async setMyCommands(commands, options) {
        calls.push({ commands, scope: options.scope.type });
      },
    };

    await configureScopedBotCommands(api, 'mainnet-beta');

    expect(calls[0]).toEqual({
      commands: MAINNET_PRIVATE_BOT_COMMANDS,
      scope: 'all_private_chats',
    });
    expect(MAINNET_PRIVATE_BOT_COMMANDS.map(({ command }) => command)).toEqual([
      'start', 'help', 'wallet', 'deposit', 'withdraw',
    ]);
    expect(calls[1]).toEqual({ commands: GROUP_BOT_COMMANDS, scope: 'all_group_chats' });
  });

  it('hides legacy custody commands from escrow menus while retaining typed recovery handlers', async () => {
    const calls: Array<{ readonly commands: readonly { readonly command: string }[]; readonly scope: string }> = [];
    const registrations: string[] = [];
    const api: BotCommandScopeApi = {
      async setMyCommands(commands, options) {
        calls.push({ commands, scope: options.scope.type });
      },
    };
    const bot = {
      command(command: string) {
        registrations.push(command);
      },
    } as unknown as Bot;
    const funded = {
      kind: 'funded',
      registerCommands(commandBot: { command(command: string): unknown }) {
        commandBot.command('wallet');
        commandBot.command('deposit');
        commandBot.command('withdraw');
      },
    } as unknown as WagerModule;

    await configureScopedBotCommands(api, 'mainnet-beta', 'escrow');
    registerWagerCommands(bot, funded, 'escrow');

    expect(calls[0]).toEqual({
      commands: ESCROW_PRIVATE_BOT_COMMANDS,
      scope: 'all_private_chats',
    });
    expect(ESCROW_PRIVATE_BOT_COMMANDS.map(({ command }) => command)).toEqual([
      'start', 'help', 'wallet',
    ]);
    expect(registrations).toEqual(['withdraw']);
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

    // Then setup guidance appears first, and readiness is claimed only after admin access
    expect(markerCalls).toBe(1);
    expect(posts).toEqual([
      'One step left: promote Called It to group admin with permission to manage messages. I will post the ready message when setup is complete.',
      'Called It is ready. Say a football call, mention me, or reply /bookit to your own message. Choose "It happens" or "It does not," then pick an amount. New calls use test SOL by default; admins can use /currency usdc. Choices and named results are visible to everyone in this Telegram group. Correct choices earn 10 points automatically. Test assets are devnet-only with no monetary value. Board: https://calledit.example/g/sunday-legends',
    ]);
  });
});
