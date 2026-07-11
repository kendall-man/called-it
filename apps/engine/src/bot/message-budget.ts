export const TELEGRAM_MESSAGE_LIMIT = 4_096;

const TRUNCATION_MARKER = '...';
const NON_INLINE_RUN = /[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}]+/gu;

function budget(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function utf16Prefix(text: string, maxLength: number): string {
  let prefix = '';
  for (const character of text) {
    if (prefix.length + character.length > maxLength) break;
    prefix += character;
  }
  return prefix;
}

export function truncateUtf16(text: string, maxLength: number): string {
  const limit = budget(maxLength);
  if (text.length <= limit) return text;
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit);
  return `${utf16Prefix(text, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

export function normalizeInlineText(
  text: string,
  maxLength: number,
  fallback: string,
): string {
  const normalized = text.replace(NON_INLINE_RUN, ' ').trim();
  return truncateUtf16(normalized.length > 0 ? normalized : fallback, maxLength);
}

export type TelegramMessageParts = {
  readonly body: string;
  readonly garnish?: string;
  readonly note?: string;
  readonly maxLength?: number;
};

export function telegramMessageBody(text: string, maxLength = TELEGRAM_MESSAGE_LIMIT): string {
  if (text.length > budget(maxLength)) {
    throw new RangeError('Mandatory Telegram message body exceeds its UTF-16 budget');
  }
  return text;
}

export function composeTelegramMessage(input: TelegramMessageParts): string {
  const limit = budget(input.maxLength ?? TELEGRAM_MESSAGE_LIMIT);
  const body = telegramMessageBody(input.body, limit);
  const rawGarnish = input.garnish ?? '';
  const rawNote = input.note ?? '';
  if (rawGarnish.length === 0 && rawNote.length === 0) return body;
  const separator = '\n\n';
  const prefixBudget = limit - body.length - separator.length;
  if (prefixBudget <= 0) return body;
  const note = truncateUtf16(rawNote, prefixBudget);
  const garnishBudget = prefixBudget - note.length - (note.length > 0 ? 1 : 0);
  const garnish = truncateUtf16(rawGarnish, garnishBudget);
  const prefix = [garnish, note].filter((part) => part.length > 0).join('\n');
  return prefix.length > 0 ? `${prefix}${separator}${body}` : body;
}
