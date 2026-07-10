import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const JSON_BODY_LIMIT_BYTES = 64 * 1024;
const FIXTURES_WINDOW_HOURS_DEFAULT = 48;
const FIXTURES_WINDOW_HOURS_MAX = 24 * 7;
const CREDENTIAL_FIELD_NAMES = new Set([
  'authorization',
  'auth',
  'token',
  'apikey',
  'bearer',
  'initdata',
  'privatekey',
  'walletprivatekey',
]);

export type RouteScope = 'concierge' | 'telegram' | 'ops';

export interface RouteCredentials {
  readonly concierge: string;
  readonly telegram: string;
  readonly ops: string;
}

export type AuthorizationResult =
  | { readonly kind: 'authorized'; readonly scope: RouteScope }
  | { readonly kind: 'wrong_scope'; readonly scope: RouteScope }
  | { readonly kind: 'unauthorized' };

export function authorizeRoute(
  req: IncomingMessage,
  credentials: RouteCredentials,
  allowed: ReadonlySet<RouteScope>,
): AuthorizationResult {
  const presentedToken = extractBearerToken(req);
  if (presentedToken === null) return { kind: 'unauthorized' };
  const presented = createHash('sha256').update(presentedToken).digest();
  const matches: RouteScope[] = [];
  for (const [scope, token] of credentialEntries(credentials)) {
    const expected = createHash('sha256').update(token).digest();
    if (timingSafeEqual(presented, expected)) matches.push(scope);
  }
  const scope = matches[0];
  if (scope === undefined) return { kind: 'unauthorized' };
  if (!allowed.has(scope)) return { kind: 'wrong_scope', scope };
  return { kind: 'authorized', scope };
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
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
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

export function hasCredentialSearchParam(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (isCredentialName(name)) return true;
  }
  return false;
}

export function hasCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasCredentialField(item));
  if (!isRecord(value)) return false;
  for (const [name, fieldValue] of Object.entries(value)) {
    if (isCredentialName(name)) return true;
    if (hasCredentialField(fieldValue)) return true;
  }
  return false;
}

export function redactedFailureReason(error: unknown): string {
  return error instanceof Error && error.name === 'ZodError'
    ? 'invalid_payload'
    : 'internal_exception';
}

function extractBearerToken(req: IncomingMessage): string | null {
  const values = req.headersDistinct.authorization
    ?? (req.headers.authorization === undefined ? [] : [req.headers.authorization]);
  if (values.length !== 1) return null;
  const [header] = values;
  if (header === undefined) return null;
  const match = /^bearer[ \t]+(.+)$/i.exec(header);
  const presentedToken = match?.[1]?.trim();
  return presentedToken && presentedToken.length > 0 ? presentedToken : null;
}

function isCredentialName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    CREDENTIAL_FIELD_NAMES.has(normalized) ||
    normalized.endsWith('token') ||
    normalized.endsWith('privatekey')
  );
}

function credentialEntries(
  credentials: RouteCredentials,
): ReadonlyArray<readonly [RouteScope, string]> {
  return [
    ['concierge', credentials.concierge],
    ['telegram', credentials.telegram],
    ['ops', credentials.ops],
  ];
}
