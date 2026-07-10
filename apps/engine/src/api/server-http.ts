import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const JSON_BODY_LIMIT_BYTES = 64 * 1024;
const FIXTURES_WINDOW_HOURS_DEFAULT = 48;
const FIXTURES_WINDOW_HOURS_MAX = 24 * 7;

export function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return false;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const presented = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(presented, expected);
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > JSON_BODY_LIMIT_BYTES) throw new Error('body too large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export function clampHours(value: string | null): number {
  const parsed = Number(value ?? FIXTURES_WINDOW_HOURS_DEFAULT);
  if (!Number.isFinite(parsed) || parsed <= 0) return FIXTURES_WINDOW_HOURS_DEFAULT;
  return Math.min(parsed, FIXTURES_WINDOW_HOURS_MAX);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
