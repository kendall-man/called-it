export const TELEGRAM_MESSAGE_LIMIT = 4_096;

const TRUNCATION_MARKER = '...';

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
