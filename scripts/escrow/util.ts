import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { EscrowControlError, EXIT } from './types.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58].map((character, index) => [character, index]));
const CREDENTIAL_FIELD = /(^|_)(access.?token|api.?(key|token)|authorization|cookie|init.?data|jwt|password|private.?key|secret|telegram.?token)($|_)/i;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{7,64}$/;

export function failInput(message: string): never {
  throw new EscrowControlError(EXIT.input, message);
}

export function failMismatch(message: string): never {
  throw new EscrowControlError(EXIT.mismatch, message);
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failInput(`${label} must be an object`);
  }
  rejectCredentialFields(value, label);
  return value as Record<string, unknown>;
}

export function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) failInput(`${label} must be a non-empty string`);
  return value;
}

export function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') failInput(`${label} must be a boolean`);
  return value;
}

export function asInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) failInput(`${label} must be a safe integer`);
  return value as number;
}

export function asAtomicString(value: unknown, label: string): string {
  const text = asString(value, label);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) failInput(`${label} must be an unsigned decimal string`);
  return text;
}

export function asSha256(value: unknown, label: string): string {
  const text = asString(value, label);
  if (!HASH.test(text)) failInput(`${label} must be a lowercase SHA-256 hex digest`);
  return text;
}

export function asCommit(value: unknown, label: string): string {
  const text = asString(value, label);
  if (!COMMIT.test(text)) failInput(`${label} must be a hexadecimal git commit`);
  return text;
}

export function asPublicKey(value: unknown, label: string): string {
  const text = asString(value, label);
  const decoded = decodeBase58(text);
  if (decoded.length !== 32) failInput(`${label} must decode to 32 bytes`);
  return text;
}

export function rejectExtraKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extras.length > 0) failInput(`${label} contains unknown fields: ${extras.sort().join(', ')}`);
}

export function rejectCredentialFields(value: unknown, path = 'input'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectCredentialFields(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (CREDENTIAL_FIELD.test(key)) failInput(`${path}.${key} is a credential-like field and is forbidden`);
    rejectCredentialFields(entry, `${path}.${key}`);
  }
}

export function redactedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(/(bearer|token|secret|password|authorization)\s*[:=]?\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

export async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    failInput(`cannot read JSON file: ${path}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    failInput(`invalid JSON file: ${path}`);
  }
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export async function sha256Tree(root: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const files = await walkFiles(absoluteRoot);
  const hash = createHash('sha256');
  for (const file of files) {
    const normalized = relative(absoluteRoot, file).split(sep).join('/');
    const data = await readFile(file);
    hash.update(Buffer.from(`${normalized}\0${data.length}\0`, 'utf8'));
    hash.update(data);
  }
  return hash.digest('hex');
}

async function walkFiles(root: string): Promise<string[]> {
  const rootStat = await stat(root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) failInput(`source directory does not exist: ${root}`);
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (['.git', 'node_modules', 'target', 'dist', 'coverage'].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else failInput(`source tree contains unsupported entry: ${path}`);
    }
  }
  await visit(root);
  return files;
}

export function decodeBase58(value: string): Buffer {
  if (value.length === 0) return Buffer.alloc(0);
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) failInput('invalid base58 value');
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.push(Number(number & 0xffn));
    number >>= 8n;
  }
  bytes.reverse();
  const leadingZeros = [...value].findIndex((character) => character !== '1');
  const zeroCount = leadingZeros === -1 ? value.length : leadingZeros;
  return Buffer.concat([Buffer.alloc(zeroCount), Buffer.from(bytes)]);
}

export function encodeBase58(bytes: Uint8Array): string {
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) | BigInt(byte);
  let encoded = '';
  while (number > 0n) {
    encoded = BASE58[Number(number % 58n)]! + encoded;
    number /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return '1'.repeat(zeros) + (encoded || (zeros === 0 ? '1' : ''));
}

export function equalJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export function bigintLe(value: bigint): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(value);
  return result;
}
