import { PublicKey } from '@solana/web3.js';
import { assertI64, assertInteger, assertLength, assertU64, U32_MAX } from './codec.js';

export type PublicKeyInput = PublicKey | string;

export function publicKey(value: PublicKeyInput): PublicKey {
  return typeof value === 'string' ? new PublicKey(value) : value;
}

export class BorshWriter {
  readonly #chunks: Uint8Array[] = [];

  bytes(value: Uint8Array): this {
    this.#chunks.push(Uint8Array.from(value));
    return this;
  }

  fixed(value: Uint8Array, length: number, name: string): this {
    return this.bytes(assertLength(value, length, name));
  }

  publicKey(value: PublicKeyInput): this {
    return this.bytes(publicKey(value).toBytes());
  }

  u8(value: number, name: string): this {
    return this.bytes(Uint8Array.of(assertInteger(value, name, 0, 0xff)));
  }

  bool(value: boolean, name: string): this {
    if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
    return this.u8(value ? 1 : 0, name);
  }

  u16(value: number, name: string): this {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, assertInteger(value, name, 0, 0xffff), true);
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

  string(value: string, name: string): this {
    const bytes = new TextEncoder().encode(value);
    return this.u32(bytes.length, `${name} length`).bytes(bytes);
  }

  optionU64(value: bigint | null, name: string): this {
    this.bool(value !== null, `${name} present`);
    return value === null ? this : this.u64(value, name);
  }

  publicKeyVector(values: readonly PublicKeyInput[], name: string): this {
    this.u32(values.length, `${name} length`);
    for (const value of values) this.publicKey(value);
    return this;
  }

  u64Vector(values: readonly bigint[], name: string): this {
    this.u32(values.length, `${name} length`);
    for (const value of values) this.u64(value, name);
    return this;
  }

  finish(): Uint8Array {
    const output = new Uint8Array(this.#chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of this.#chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

export class BorshReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  fixed(length: number, name: string): Uint8Array {
    const end = this.#offset + length;
    if (end > this.#bytes.length) throw new RangeError(`${name} exceeds the available account data`);
    const value = this.#bytes.slice(this.#offset, end);
    this.#offset = end;
    return value;
  }

  publicKey(name: string): string {
    return new PublicKey(this.fixed(32, name)).toBase58();
  }

  u8(name: string): number {
    return this.fixed(1, name)[0] ?? 0;
  }

  bool(name: string): boolean {
    const value = this.u8(name);
    if (value > 1) throw new RangeError(`${name} has an invalid Borsh boolean tag`);
    return value === 1;
  }

  u16(name: string): number {
    const bytes = this.fixed(2, name);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true);
  }

  u32(name: string): number {
    const bytes = this.fixed(4, name);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  }

  u64(name: string): bigint {
    const bytes = this.fixed(8, name);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
  }

  i64(name: string): bigint {
    const bytes = this.fixed(8, name);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(0, true);
  }

  optionU64(name: string): bigint | null {
    const tag = this.u8(`${name} option`);
    if (tag > 1) throw new RangeError(`${name} has an invalid Borsh option tag`);
    return tag === 0 ? null : this.u64(name);
  }

  publicKeyVector(name: string, maximumLength: number): readonly string[] {
    const length = this.u32(`${name} length`);
    if (length > maximumLength) throw new RangeError(`${name} exceeds maximum length ${maximumLength}`);
    return Array.from({ length }, (_, index) => this.publicKey(`${name}[${index}]`));
  }

  u64Vector(name: string, maximumLength: number): readonly bigint[] {
    const length = this.u32(`${name} length`);
    if (length > maximumLength) throw new RangeError(`${name} exceeds maximum length ${maximumLength}`);
    return Array.from({ length }, (_, index) => this.u64(`${name}[${index}]`));
  }

  finish(name: string): void {
    if (this.#offset !== this.#bytes.length) {
      throw new RangeError(`${name} has ${this.#bytes.length - this.#offset} unexpected trailing bytes`);
    }
  }

  finishZeroPadded(name: string): void {
    const trailing = this.#bytes.subarray(this.#offset);
    if (trailing.some((byte) => byte !== 0)) {
      throw new RangeError(`${name} has unexpected non-zero trailing bytes`);
    }
    this.#offset = this.#bytes.length;
  }
}
