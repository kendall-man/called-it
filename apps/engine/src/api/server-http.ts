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

export type RouteScope = 'concierge' | 'telegram' | 'ops' | 'escrow_web';

export interface RouteCredentials {
  readonly concierge: string;
  readonly telegram: string;
  readonly ops: string;
  /** SHA-256 hex digest only; the engine never stores the web bearer plaintext. */
  readonly escrowWebSha256?: string;
}

type CredentialDigest = {
  readonly scope: RouteScope;
  readonly digest: Buffer;
};

export interface RouteCredentialBoundary {
  readonly authorize: (
    req: IncomingMessage,
    allowed: ReadonlySet<RouteScope>,
  ) => AuthorizationResult;
  readonly hasCredentialSearchParam: (url: URL) => boolean;
  readonly hasCredentialField: (
    value: unknown,
    allowedTopLevelNames?: ReadonlySet<string>,
  ) => boolean;
}

export type AuthorizationResult =
  | { readonly kind: 'authorized'; readonly scope: RouteScope }
  | { readonly kind: 'wrong_scope'; readonly scope: RouteScope }
  | { readonly kind: 'unauthorized' };

export function createRouteCredentialBoundary(
  credentials: RouteCredentials,
): RouteCredentialBoundary {
  const digests = credentialDigests(credentials);
  return {
    authorize(req, allowed) {
      const scope = matchingCredentialScope(extractBearerToken(req), digests);
      if (scope === null) return { kind: 'unauthorized' };
      if (!allowed.has(scope)) return { kind: 'wrong_scope', scope };
      return { kind: 'authorized', scope };
    },
    hasCredentialSearchParam(url) {
      for (const [name, value] of url.searchParams.entries()) {
        if (isCredentialName(name) || isKnownCredentialValue(value, digests)) return true;
      }
      return false;
    },
    hasCredentialField(value, allowedTopLevelNames = new Set()) {
      return hasCredentialTransportValue(value, digests, allowedTopLevelNames, true);
    },
  };
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

function hasCredentialTransportValue(
  value: unknown,
  digests: ReadonlyArray<CredentialDigest>,
  allowedTopLevelNames: ReadonlySet<string>,
  topLevel: boolean,
): boolean {
  if (typeof value === 'string') return isKnownCredentialValue(value, digests);
  if (Array.isArray(value)) {
    return value.some((item) => hasCredentialTransportValue(item, digests, new Set(), false));
  }
  if (!isRecord(value)) return false;
  for (const [name, fieldValue] of Object.entries(value)) {
    const allowedDomainField = topLevel && allowedTopLevelNames.has(name);
    if (isCredentialName(name) && !allowedDomainField) return true;
    if (hasCredentialTransportValue(fieldValue, digests, new Set(), false)) return true;
  }
  return false;
}

function isKnownCredentialValue(
  value: string,
  digests: ReadonlyArray<CredentialDigest>,
): boolean {
  return matchingCredentialScope(value, digests) !== null;
}

function matchingCredentialScope(
  value: string | null,
  digests: ReadonlyArray<CredentialDigest>,
): RouteScope | null {
  if (value === null) return null;
  const presented = createHash('sha256').update(value).digest();
  for (const digest of digests) {
    if (timingSafeEqual(presented, digest.digest)) return digest.scope;
  }
  return null;
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

function credentialDigests(credentials: RouteCredentials): ReadonlyArray<CredentialDigest> {
  const digests = credentialEntries(credentials).map(([scope, token]) => ({
    scope,
    digest: createHash('sha256').update(token).digest(),
  }));
  if (/^[0-9a-f]{64}$/i.test(credentials.escrowWebSha256 ?? '')) {
    digests.push({
      scope: 'escrow_web',
      digest: Buffer.from(credentials.escrowWebSha256 ?? '', 'hex'),
    });
  }
  return digests;
}
