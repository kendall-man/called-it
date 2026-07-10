import { createHmac } from 'node:crypto';
import type {
  TelegramSourceFingerprint,
  TelegramSourceKey,
  TelegramValidatedUpdate,
} from './ports.js';

const TELEGRAM_SOURCE_NAMESPACE = Buffer.from('telegram-source', 'utf8');

type TelegramSourceIdentity = {
  readonly sourceKey: TelegramSourceKey;
  readonly sourceFingerprint: TelegramSourceFingerprint;
  readonly telegramUpdateId: number;
  readonly updateType: string;
};

export class TelegramSourceIdentityError extends Error {
  readonly name = 'TelegramSourceIdentityError';

  constructor(message: string) {
    super(message);
  }
}

export function deriveTelegramSourceIdentity(
  update: TelegramValidatedUpdate,
  analyticsHmacSecretBase64: string,
): TelegramSourceIdentity {
  const telegramUpdateId = integerField(update, 'update_id');
  const updateType = detectUpdateType(update);
  const sourceKey = sourceKeyForUpdate(update, updateType, telegramUpdateId);
  return {
    sourceKey,
    sourceFingerprint: fingerprintForSourceKey(sourceKey, analyticsHmacSecretBase64),
    telegramUpdateId,
    updateType,
  };
}

function detectUpdateType(update: TelegramValidatedUpdate): string {
  for (const key of Object.keys(update)) {
    if (key !== 'update_id') {
      return key;
    }
  }
  throw new TelegramSourceIdentityError('validated update missing type discriminator');
}

function sourceKeyForUpdate(
  update: TelegramValidatedUpdate,
  updateType: string,
  telegramUpdateId: number,
): TelegramSourceKey {
  if ('message' in update) {
    const message = objectField(update, 'message');
    const chat = objectField(message, 'chat');
    return brandSourceKey(`msg:${integerField(chat, 'id')}:${integerField(message, 'message_id')}`);
  }
  if ('callback_query' in update) {
    const callbackQuery = objectField(update, 'callback_query');
    return brandSourceKey(`cb:${stringField(callbackQuery, 'id')}`);
  }
  if ('my_chat_member' in update) {
    const membership = objectField(update, 'my_chat_member');
    const chat = objectField(membership, 'chat');
    return brandSourceKey(`member:${integerField(chat, 'id')}:${telegramUpdateId}`);
  }
  return brandSourceKey(`upd:${telegramUpdateId}:${updateType}`);
}

function fingerprintForSourceKey(
  sourceKey: TelegramSourceKey,
  analyticsHmacSecretBase64: string,
): TelegramSourceFingerprint {
  const key = Buffer.from(analyticsHmacSecretBase64, 'base64');
  if (key.length === 0) {
    throw new TelegramSourceIdentityError('analytics HMAC secret does not decode');
  }
  const digest = createHmac('sha256', key)
    .update(TELEGRAM_SOURCE_NAMESPACE)
    .update(Buffer.from(sourceKey, 'utf8'))
    .digest('base64url');
  if (!/^[A-Za-z0-9_-]{43}$/.test(digest)) {
    throw new TelegramSourceIdentityError('source fingerprint is not unpadded base64url');
  }
  return digest as TelegramSourceFingerprint;
}

function objectField(row: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  const value = row[key];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  throw new TelegramSourceIdentityError(`validated update field ${key} is not an object`);
}

function integerField(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  throw new TelegramSourceIdentityError(`validated update field ${key} is not a safe integer`);
}

function stringField(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw new TelegramSourceIdentityError(`validated update field ${key} is not a non-empty string`);
}

function brandSourceKey(value: string): TelegramSourceKey {
  return value as TelegramSourceKey;
}
