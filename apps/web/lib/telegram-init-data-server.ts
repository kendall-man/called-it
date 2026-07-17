import { createHmac, timingSafeEqual } from 'node:crypto';

const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const INTEGER_PATTERN = /^(?:0|[1-9]\d{0,15})$/;
const MAX_INIT_DATA_LENGTH = 8_192;
const DEFAULT_MAX_AGE_SECONDS = 300;
const MAX_FUTURE_SKEW_SECONDS = 30;

export class TelegramInitDataError extends Error {
  readonly name = 'TelegramInitDataError';

  constructor(readonly code: 'invalid' | 'expired') {
    super(code);
  }
}

export function verifyTelegramInitData(
  initData: string,
  options: {
    readonly botToken: string;
    readonly maxAgeSeconds?: number;
    readonly now?: Date;
  },
): { readonly telegramUserId: number } {
  if (
    initData.length === 0 || initData.length > MAX_INIT_DATA_LENGTH ||
    options.botToken.length === 0
  ) throw new TelegramInitDataError('invalid');

  const fields = new URLSearchParams(initData);
  const values = new Map<string, string>();
  for (const [key, value] of fields) {
    if (key.length === 0 || values.has(key)) throw new TelegramInitDataError('invalid');
    values.set(key, value);
  }
  const receivedHash = values.get('hash');
  if (receivedHash === undefined || !HASH_PATTERN.test(receivedHash)) {
    throw new TelegramInitDataError('invalid');
  }
  values.delete('hash');
  const dataCheckString = [...values.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(options.botToken).digest();
  const expectedHash = createHmac('sha256', secret).update(dataCheckString).digest();
  const receivedHashBytes = Buffer.from(receivedHash, 'hex');
  if (
    receivedHashBytes.length !== expectedHash.length ||
    !timingSafeEqual(receivedHashBytes, expectedHash)
  ) throw new TelegramInitDataError('invalid');

  const authDateValue = values.get('auth_date');
  if (authDateValue === undefined || !INTEGER_PATTERN.test(authDateValue)) {
    throw new TelegramInitDataError('invalid');
  }
  const authDate = Number(authDateValue);
  const now = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (
    !Number.isSafeInteger(authDate) || !Number.isSafeInteger(maxAge) || maxAge <= 0 ||
    authDate > now + MAX_FUTURE_SKEW_SECONDS || now - authDate > maxAge
  ) throw new TelegramInitDataError('expired');

  const userValue = values.get('user');
  if (userValue === undefined) throw new TelegramInitDataError('invalid');
  let user: unknown;
  try {
    user = JSON.parse(userValue);
  } catch {
    throw new TelegramInitDataError('invalid');
  }
  const telegramUserId = record(user)?.id;
  if (
    typeof telegramUserId !== 'number' ||
    !Number.isSafeInteger(telegramUserId) || telegramUserId <= 0
  ) throw new TelegramInitDataError('invalid');
  return { telegramUserId };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}
