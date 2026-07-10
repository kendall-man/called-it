import type {
  TelegramOwnedMessageResolver,
  TelegramPrefilter,
  TelegramRoutingDecision,
  TelegramValidatedUpdate,
} from './ports.js';

export function createTelegramRoutingPolicy(input: {
  readonly botUsername: string;
  readonly prefilter: TelegramPrefilter;
  readonly resolveOwnedReply: TelegramOwnedMessageResolver;
}): (update: TelegramValidatedUpdate) => Promise<TelegramRoutingDecision> {
  const botMention = `@${input.botUsername}`;
  return async (update) => {
    if ('my_chat_member' in update) {
      return 'pending_engine';
    }
    if ('callback_query' in update) {
      return 'pending_engine';
    }
    const message = messageFromUpdate(update);
    if (message === null) {
      return 'pending_engine';
    }
    if (hasBotCommand(message)) {
      return 'pending_engine';
    }
    const chat = objectField(message, 'chat');
    const chatType = stringField(chat, 'type');
    const text = stringField(message, 'text');
    const replyMessage = optionalObjectField(message, 'reply_to_message');
    if (replyMessage !== null) {
      const resolvedOwner = await input.resolveOwnedReply(
        integerField(chat, 'id'),
        integerField(replyMessage, 'message_id'),
      );
      if (resolvedOwner === 'engine') {
        return 'pending_engine';
      }
      const strippedReplyMention = stripExactBotMention(text, botMention);
      if (chatType !== 'private' && strippedReplyMention === null) {
        return 'routed_concierge';
      }
      if (strippedReplyMention !== null) {
        return (await input.prefilter(strippedReplyMention)) ? 'pending_engine' : 'routed_concierge';
      }
    }
    const strippedMention = stripExactBotMention(text, botMention);
    if (strippedMention !== null) {
      return (await input.prefilter(strippedMention)) ? 'pending_engine' : 'routed_concierge';
    }
    return chatType === 'private' ? 'routed_concierge' : 'pending_engine';
  };
}

function messageFromUpdate(update: TelegramValidatedUpdate): Readonly<Record<string, unknown>> | null {
  const value = update.message;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  return null;
}

function hasBotCommand(message: Readonly<Record<string, unknown>>): boolean {
  const entities = message.entities;
  if (!Array.isArray(entities)) {
    return false;
  }
  return entities.some(
    (entity) =>
      typeof entity === 'object' &&
      entity !== null &&
      !Array.isArray(entity) &&
      entity.type === 'bot_command' &&
      entity.offset === 0,
  );
}

function stripExactBotMention(text: string, botMention: string): string | null {
  const escapedMention = botMention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`(^|\\s)${escapedMention}(?=\\s|$)`));
  if (match === null || match.index === undefined) {
    return null;
  }
  const prefix = text.slice(0, match.index);
  const suffix = text.slice(match.index + match[0].length);
  const stripped = `${prefix}${match[1] === '' ? '' : ' '}${suffix}`.trim();
  return stripped;
}

function objectField(row: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  const value = row[key];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  throw new Error(`validated update field ${key} is not an object`);
}

function optionalObjectField(
  row: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const value = row[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  throw new Error(`validated update field ${key} is not an object`);
}

function integerField(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  throw new Error(`validated update field ${key} is not a safe integer`);
}

function stringField(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`validated update field ${key} is not a string`);
}
