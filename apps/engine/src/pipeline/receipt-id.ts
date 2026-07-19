const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Encodes a canonical UUID as its reversible, padding-free 22-character URL id. */
export function encodeReceiptId(uuid: string): string | null {
  if (!UUID_PATTERN.test(uuid)) return null;
  const hex = uuid.replaceAll('-', '');
  const bytes = Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    encoded += BASE64URL[(value >>> 18) & 63] ?? '';
    encoded += BASE64URL[(value >>> 12) & 63] ?? '';
    if (remaining > 1) encoded += BASE64URL[(value >>> 6) & 63] ?? '';
    if (remaining > 2) encoded += BASE64URL[value & 63] ?? '';
  }
  return encoded;
}

/** Decodes a compact receipt id to the canonical lowercase UUID used by storage and APIs. */
export function decodeReceiptId(value: string): string | null {
  if (!COMPACT_PATTERN.test(value)) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE64URL.indexOf(character);
    if (digit < 0) return null;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
      buffer &= bits === 0 ? 0 : (1 << bits) - 1;
    }
  }
  if (bytes.length !== 16 || bits !== 4 || buffer !== 0) return null;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
