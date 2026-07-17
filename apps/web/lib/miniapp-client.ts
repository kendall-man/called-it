import { z } from 'zod';

const OpenSessionSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAtIso: z.string().datetime({ offset: true }),
});

const ErrorSchema = z.object({ error: z.string().min(1).max(100) }).passthrough();
const REQUEST_TIMEOUT_MS = 15_000;

export class MiniAppClientError extends Error {
  readonly name = 'MiniAppClientError';

  constructor(readonly code: string) {
    super(code);
  }
}

export type MiniAppOpenSession = Readonly<z.infer<typeof OpenSessionSchema>>;

export async function requestMiniAppPositionSession(initData: string): Promise<MiniAppOpenSession> {
  return openSession('/api/position/open', initData);
}

export async function requestMiniAppWalletSession(initData: string): Promise<MiniAppOpenSession> {
  return openSession('/api/wallet/open', initData);
}

async function openSession(path: string, initData: string): Promise<MiniAppOpenSession> {
  if (initData.length === 0) throw new MiniAppClientError('telegram_auth_required');
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData }),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    throw new MiniAppClientError('sponsor_unavailable');
  } finally {
    globalThis.clearTimeout(timeout);
  }
  let value: unknown;
  try { value = await response.json(); } catch { value = null; }
  if (!response.ok) throw new MiniAppClientError(responseError(value));
  const parsed = OpenSessionSchema.safeParse(value);
  if (!parsed.success) throw new MiniAppClientError(responseError(value));
  return parsed.data;
}

function responseError(value: unknown): string {
  const parsed = ErrorSchema.safeParse(value);
  return parsed.success ? parsed.data.error : 'sponsor_unavailable';
}
