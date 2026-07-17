import { EntryEventSchema } from '../../../lib/entry';

const MAX_RECENT_EVENT_KEYS = 512;
const recentEventKeys = new Set<string>();

function isJsonRequest(request: Request): boolean {
  const contentType = request.headers.get('content-type') ?? '';
  return /^application\/json(?:\s*;|$)/i.test(contentType);
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return false;

  const requestUrl = new URL(request.url);
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProtocol === 'https' || forwardedProtocol === 'http'
    ? forwardedProtocol
    : requestUrl.protocol.slice(0, -1);
  const host = request.headers.get('host') || requestUrl.host;
  return origin === `${protocol}://${host}`;
}

function rememberEvent(key: string, seenKeys: Set<string>): boolean {
  if (seenKeys.has(key)) return false;

  seenKeys.add(key);
  if (seenKeys.size > MAX_RECENT_EVENT_KEYS) {
    const oldestKey = seenKeys.values().next().value;
    if (typeof oldestKey === 'string') seenKeys.delete(oldestKey);
  }
  return true;
}

/**
 * This route validates the public event boundary before backend ingestion is
 * available. It intentionally does not access a database, credentials, or
 * request-derived identity data.
 */
export async function handleEntryEvent(
  request: Request,
  seenKeys: Set<string> = recentEventKeys,
): Promise<Response> {
  if (!isSameOrigin(request)) {
    return Response.json({ error: 'origin_forbidden' }, { status: 403 });
  }
  if (!isJsonRequest(request)) {
    return Response.json({ error: 'invalid_event' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_event' }, { status: 400 });
  }

  const parsed = EntryEventSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_event' }, { status: 400 });
  }

  const inserted = rememberEvent(
    `${parsed.data.sessionId}:${parsed.data.idempotencyKey}`,
    seenKeys,
  );
  return Response.json(
    { status: 'unavailable', ingested: false, duplicate: !inserted },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
