/**
 * Byte-level codecs shared by the node-side txoracle client and the
 * ISOMORPHIC verify module. Nothing in this file may import node-only
 * modules — it runs unchanged in browsers.
 */

/** Accepted encodings for a 32-byte hash arriving from TxLINE payloads. */
export type HashInput = string | Uint8Array | readonly number[];

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RADIX = 58;
const BYTE_RADIX = 256;
const HEX_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Decode a base58 (Bitcoin alphabet) string — the Solana address encoding. */
export function base58Decode(encoded: string): Uint8Array {
  let leadingZeros = 0;
  while (leadingZeros < encoded.length && encoded[leadingZeros] === '1') {
    leadingZeros += 1;
  }
  // Little-endian byte accumulator for the base-58 big number.
  const accumulator: number[] = [];
  for (const char of encoded) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) {
      throw new Error(`invalid base58 character "${char}"`);
    }
    let carry = digit;
    for (let i = 0; i < accumulator.length; i += 1) {
      carry += (accumulator[i] ?? 0) * BASE58_RADIX;
      accumulator[i] = carry % BYTE_RADIX;
      carry = Math.floor(carry / BYTE_RADIX);
    }
    while (carry > 0) {
      accumulator.push(carry % BYTE_RADIX);
      carry = Math.floor(carry / BYTE_RADIX);
    }
  }
  const out = new Uint8Array(leadingZeros + accumulator.length);
  for (let i = 0; i < accumulator.length; i += 1) {
    out[out.length - 1 - i] = accumulator[i] ?? 0;
  }
  return out;
}

/** Encode bytes as base58 (Bitcoin alphabet). */
export function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1;
  }
  // Little-endian base-58 digit accumulator.
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += (digits[i] ?? 0) * BYTE_RADIX;
      digits[i] = carry % BASE58_RADIX;
      carry = Math.floor(carry / BASE58_RADIX);
    }
    while (carry > 0) {
      digits.push(carry % BASE58_RADIX);
      carry = Math.floor(carry / BASE58_RADIX);
    }
  }
  let out = '1'.repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i] ?? 0];
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** Base64 → bytes using the isomorphic `atob` (available in Node 16+ and browsers). */
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Decode a hash that may arrive as hex, base64 (the OpenAPI `format: binary`
 * fields serialize to base64 in JSON), a Uint8Array, or a plain number array.
 * A 64-char all-hex string is treated as hex — base64 of a 32-byte hash is
 * 44 chars, so the two never collide for well-formed inputs.
 */
export function decodeHashInput(input: HashInput): Uint8Array {
  if (input instanceof Uint8Array) return Uint8Array.from(input);
  if (Array.isArray(input)) return Uint8Array.from(input as number[]);
  if (typeof input === 'string') {
    if (HEX_HASH_PATTERN.test(input)) return hexToBytes(input);
    return base64ToBytes(input);
  }
  throw new Error('unsupported hash encoding');
}
