import { sha256 } from '@noble/hashes/sha256';

export const U8_MAX = 0xff;
export const U16_MAX = 0xffff;
export const U32_MAX = 0xffff_ffff;
export const U64_MAX = (1n << 64n) - 1n;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;

const textEncoder = new TextEncoder();
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function assertInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

export function assertU64(value: bigint, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw new RangeError(`${name} must be a u64 bigint`);
  }
  return value;
}

export function assertI64(value: bigint, name: string): bigint {
  if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX) {
    throw new RangeError(`${name} must be an i64 bigint`);
  }
  return value;
}

export function assertLength(value: Uint8Array, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${name} must be exactly ${length} bytes`);
  }
  return value;
}

export function utf8(value: string, name: string, maximumBytes: number): Uint8Array {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const bytes = textEncoder.encode(value);
  if (bytes.length > maximumBytes) {
    throw new RangeError(`${name} must be at most ${maximumBytes} UTF-8 bytes`);
  }
  return bytes;
}

export function uuidToBytes(value: string): Uint8Array {
  if (!UUID_PATTERN.test(value)) throw new Error('market UUID must use canonical 8-4-4-4-12 form');
  return hexToBytes(value.replaceAll('-', '').toLowerCase());
}

export function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || /[^0-9a-fA-F]/.test(value)) {
    throw new Error('invalid hexadecimal string');
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hashCanonicalBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(sha256(value));
}

export class CanonicalWriter {
  readonly #chunks: Uint8Array[] = [];

  bytes(value: Uint8Array): this {
    this.#chunks.push(Uint8Array.from(value));
    return this;
  }

  fixed(value: Uint8Array, length: number, name: string): this {
    return this.bytes(assertLength(value, length, name));
  }

  u8(value: number, name: string): this {
    return this.bytes(Uint8Array.of(assertInteger(value, name, 0, U8_MAX)));
  }

  bool(value: boolean, name: string): this {
    if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
    return this.u8(value ? 1 : 0, name);
  }

  u16(value: number, name: string): this {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, assertInteger(value, name, 0, U16_MAX), true);
    return this.bytes(bytes);
  }

  u32(value: number, name: string): this {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, assertInteger(value, name, 0, U32_MAX), true);
    return this.bytes(bytes);
  }

  u64(value: bigint, name: string): this {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, assertU64(value, name), true);
    return this.bytes(bytes);
  }

  i64(value: bigint, name: string): this {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, assertI64(value, name), true);
    return this.bytes(bytes);
  }

  string16(value: string, name: string, maximumBytes = U16_MAX): this {
    const bytes = utf8(value, name, Math.min(maximumBytes, U16_MAX));
    return this.u16(bytes.length, `${name} length`).bytes(bytes);
  }

  string32(value: string, name: string, maximumBytes = U32_MAX): this {
    const bytes = utf8(value, name, maximumBytes);
    return this.u32(bytes.length, `${name} length`).bytes(bytes);
  }

  finish(): Uint8Array {
    const length = this.#chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

export function writeDomain(writer: CanonicalWriter, domain: string, version = 1): void {
  writer.string16(domain, 'domain separator', 96).u8(version, 'schema version');
}
