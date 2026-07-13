/**
 * grammY bot assembly: scoped commands, group lifecycle onboarding, then
 * commands → callbacks → detection.
 */

import type { Bot } from 'grammy';
import type { Logger } from '../log.js';
import type { HandlerCtx } from './context.js';
import { registerCommands } from './commands.js';
import { registerCallbacks } from './callbacks.js';
import { registerDetection } from './detection.js';
import type { EngineDb } from '../ports.js';
import type { Env } from '../env.js';
import type { SolanaNetwork } from '../solana-network.js';
import type { Poster } from './poster.js';
import type { WagerModule } from '../wager/module.js';
import {
  claimGroupReadiness,
  groupReadyMarkerStore,
  readyMessageForGroup,
} from './onboarding.js';
import { isBetaGroupAllowed } from './beta-access.js';

export interface BotErrorRegistrar {
  catch(handler: (error: { readonly error: unknown }) => unknown): void;
}

function botFailureReason(error: unknown): 'bot_handler_exception' | 'unknown_exception' {
  return error instanceof Error ? 'bot_handler_exception' : 'unknown_exception';
}

export function registerBotErrorHandler(bot: BotErrorRegistrar, log: Logger): void {
  bot.catch((err) => {
    log.error('bot_update_failed', { reason: botFailureReason(err.error) });
  });
}

export const PRIVATE_BOT_COMMANDS = [
  { command: 'start', description: 'Add Called It to a group' },
  { command: 'help', description: 'How Called It works' },
  { command: 'wallet', description: 'Create or manage your wallet' },
  { command: 'deposit', description: 'Add SOL to your balance' },
  { command: 'withdraw', description: 'Return SOL to your wallet' },
] as const;

export const MAINNET_PRIVATE_BOT_COMMANDS = PRIVATE_BOT_COMMANDS;

export const GROUP_BOT_COMMANDS = [
  { command: 'bookit', description: 'Book an explicit call' },
  { command: 'leaderboard', description: 'View the group top 10' },
  { command: 'mystats', description: 'View your group stats' },
  { command: 'table', description: 'Open the group board' },
  { command: 'help', description: 'How Called It works' },
] as const;

/** The legacy main hook clears Telegram's default scope; user scopes are exact. */
export const BOT_COMMANDS = [] as const;

type BotCommandScope =
  | { readonly type: 'all_private_chats' }
  | { readonly type: 'all_group_chats' };

export interface BotCommandScopeApi {
  setMyCommands(
    commands: readonly { readonly command: string; readonly description: string }[],
    options: { readonly scope: BotCommandScope },
  ): Promise<unknown>;
}

export async function configureScopedBotCommands(
  api: BotCommandScopeApi,
  network: SolanaNetwork = 'devnet',
): Promise<void> {
  await api.setMyCommands(
    network === 'mainnet-beta' ? MAINNET_PRIVATE_BOT_COMMANDS : PRIVATE_BOT_COMMANDS,
    { scope: { type: 'all_private_chats' } },
  );
  await api.setMyCommands(GROUP_BOT_COMMANDS, { scope: { type: 'all_group_chats' } });
}

export function registerWagerCommands(bot: Bot, wager: WagerModule | null): void {
  if (wager?.kind === 'funded') wager.registerCommands(bot);
}

export interface GroupLifecycleContext {
  readonly chat: { readonly id: number; readonly type: string; readonly title?: string };
  readonly myChatMember: {
    readonly new_chat_member: { readonly status: string };
    readonly old_chat_member: { readonly status: string };
  };
}

export interface GroupLifecycleBot {
  on(
    filter: 'my_chat_member',
    handler: (ctx: GroupLifecycleContext) => Promise<unknown>,
  ): void;
}

export interface GroupLifecycleHandlerCtx {
  readonly deps: {
    readonly db: Pick<EngineDb, 'upsertGroup' | 'setGroupAdmin' | 'markGroupReady'>;
    readonly env: Pick<Env, 'WEB_BASE_URL' | 'DEPLOYMENT_ENV' | 'BETA_ALLOWED_GROUP_IDS'>
      & Partial<Pick<Env, 'SOLANA_NETWORK'>>;
    readonly log: Pick<Logger, 'info' | 'warn'>;
  };
  readonly poster: Pick<Poster, 'post'>;
}

function isGroupChat(chatType: string): boolean {
  return chatType === 'group' || chatType === 'supergroup';
}

export function registerGroupLifecycleHandlers(bot: GroupLifecycleBot, h: GroupLifecycleHandlerCtx): void {
  bot.on('my_chat_member', async (ctx) => {
    const chat = ctx.chat;
    if (!isGroupChat(chat.type)) return;
    if (!isBetaGroupAllowed(h.deps.env, chat.id)) {
      h.deps.log.info('beta_group_not_allowlisted');
      return;
    }
    const next = ctx.myChatMember.new_chat_member.status;
    const previous = ctx.myChatMember.old_chat_member.status;
    const group = await h.deps.db.upsertGroup({ id: chat.id, title: chat.title ?? '' });
    h.deps.log.info('membership_change', { previous, next });

    if (next === 'administrator') {
      await h.deps.db.setGroupAdmin(chat.id, true);
    } else if (next === 'member') {
      await h.deps.db.setGroupAdmin(chat.id, false);
    } else {
      return;
    }

    const marker = await claimGroupReadiness(groupReadyMarkerStore(h.deps.db), group.id);
    if (!marker.ok) {
      h.deps.log.warn('group_readiness_rejected', { code: marker.code });
      return;
    }

    if (marker.created) {
      h.poster.post(chat.id, readyMessageForGroup({
        group,
        webBaseUrl: h.deps.env.WEB_BASE_URL,
        solanaNetwork: h.deps.env.SOLANA_NETWORK,
      }));
    }
  });
}

export function registerBotHandlers(bot: Bot, h: HandlerCtx): void {
  registerBotErrorHandler(bot, h.deps.log);
  void configureScopedBotCommands(bot.api, h.deps.env.SOLANA_NETWORK).catch((error: unknown) => {
    h.deps.log.warn('set_scoped_commands_failed', {
      reason: error instanceof Error ? 'bot_api_error' : 'unknown_error',
    });
  });

  registerGroupLifecycleHandlers(bot, h);

  registerCommands(bot, h);
  registerWagerCommands(bot, h.deps.wager);
  registerCallbacks(bot, h);
  registerDetection(bot, h);
}
