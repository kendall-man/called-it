import { Bot, Context } from 'grammy';
import type { Update, User, UserFromGetMe } from 'grammy/types';
import {
  createTelegramFetch,
  telegramJsonResponse,
  type TelegramFetchBody,
  type TelegramFetchInput,
} from './telegram-points-flow-fetch.test-support.js';

export const TEST_BOT_TOKEN = '123456:telegram-flow-fixture';

const BOT_INFO: UserFromGetMe = {
  id: 606_060,
  is_bot: true,
  first_name: 'Called It',
  username: 'calledit_fixture_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export type TelegramCall = {
  readonly method: string;
  readonly chatId: number | null;
  readonly text: string | null;
  readonly messageId: number;
};

function requestUrl(input: TelegramFetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return 'url' in input ? input.url : input.href;
}

function payloadFrom(body: TelegramFetchBody): unknown {
  if (typeof body !== 'string') return {};
  const payload: unknown = JSON.parse(body);
  return payload;
}

function field(payload: unknown, name: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return Object.getOwnPropertyDescriptor(payload, name)?.value;
}

function stringField(payload: unknown, name: string): string | null {
  const value = field(payload, name);
  return typeof value === 'string' ? value : null;
}

function numberField(payload: unknown, name: string): number | null {
  const value = field(payload, name);
  return typeof value === 'number' ? value : null;
}

export class TelegramTransport {
  readonly calls: TelegramCall[] = [];
  private nextMessageId = 1_000;

  constructor(private readonly trace: string[]) {}

  readonly fetch = createTelegramFetch(
    async (input, init) => {
      const method = new URL(requestUrl(input)).pathname.split('/').at(-1) ?? 'unknown';
      const payload = payloadFrom(init?.body);
      const text = stringField(payload, 'text');
      const messageId = numberField(payload, 'message_id') ?? this.nextMessageId++;
      const chatId = numberField(payload, 'chat_id');
      this.calls.push({ method, chatId, text, messageId });
      this.trace.push(`telegram:${method}:${text?.split('\n')[0] ?? ''}`);
      const result = method === 'answerCallbackQuery' || method === 'editMessageReplyMarkup'
        ? true
        : {
            message_id: messageId,
            date: 1_783_814_400,
            chat: { id: chatId ?? 0, type: 'supergroup', title: 'Fixture group' },
            text: text ?? '',
          };
      return telegramJsonResponse({ ok: true, result });
    },
  );

  createBot(): Bot {
    return new Bot(TEST_BOT_TOKEN, {
      botInfo: BOT_INFO,
      client: {
        fetch: this.fetch,
        buildUrl: (_root, _token, method) => `https://telegram.invalid/${method}`,
      },
    });
  }

  outboundTexts(): readonly string[] {
    return this.calls.flatMap((call) => call.text === null ? [] : [call.text]);
  }
}

export function telegramUser(
  id: number,
  firstName: string,
  username?: string,
): User {
  return {
    id,
    is_bot: false,
    first_name: firstName,
    ...(username === undefined ? {} : { username }),
  };
}

export function callbackContext(input: {
  readonly bot: Bot;
  readonly updateId: number;
  readonly callbackId: string;
  readonly groupId: number;
  readonly groupTitle: string;
  readonly messageId: number;
  readonly user: User;
}): Context {
  const update: Update = {
    update_id: input.updateId,
    callback_query: {
      id: input.callbackId,
      from: input.user,
      chat_instance: 'telegram-flow-fixture',
      message: {
        message_id: input.messageId,
        date: 0,
        chat: { id: input.groupId, type: 'supergroup', title: input.groupTitle },
      },
    },
  };
  return new Context(update, input.bot.api, BOT_INFO);
}

export function commandUpdate(input: {
  readonly updateId: number;
  readonly messageId: number;
  readonly groupId: number;
  readonly groupTitle: string;
  readonly command: 'leaderboard' | 'mystats';
  readonly user: User;
}): Update {
  const text = `/${input.command}`;
  return {
    update_id: input.updateId,
    message: {
      message_id: input.messageId,
      date: 1_783_814_400,
      chat: { id: input.groupId, type: 'supergroup', title: input.groupTitle },
      from: input.user,
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  };
}
