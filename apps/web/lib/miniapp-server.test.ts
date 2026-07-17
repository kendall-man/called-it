import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  miniAppPositionIdempotencyKey,
  miniAppWalletIdempotencyKey,
  openMiniAppPositionSession,
  openMiniAppWalletSession,
  type MiniAppServerConfig,
} from './miniapp-server';

const BOT_TOKEN = '123456789:test-bot-token-secret';
const NOW = new Date('2030-01-01T00:00:00.000Z');
const BUCKET = Math.floor(NOW.getTime() / 1_000 / 30);
const MARKET_HEX = '8ec17c8a2a304f089b757cbe565d568f';
const MARKET_ID = '8ec17c8a-2a30-4f08-9b75-7cbe565d568f';
const ENGINE_TOKEN = 'web-bridge-token-with-more-than-32-bytes';
const SESSION_TOKEN = 'B'.repeat(43);
const EXPIRES_AT_ISO = '2030-01-01T00:05:00.000Z';

const CONFIG: MiniAppServerConfig = {
  custodyMode: 'escrow',
  engineToken: ENGINE_TOKEN,
  engineUrl: 'https://engine.example.test',
  telegramBotToken: BOT_TOKEN,
};

function signedInitData(input: {
  readonly authDate?: number;
  readonly botToken?: string;
  readonly startParam?: string;
  readonly userId?: number;
  readonly username?: string;
} = {}): string {
  const user: Record<string, unknown> = { id: input.userId ?? 42, first_name: 'Priya' };
  if (input.username !== undefined) user.username = input.username;
  const fields = new URLSearchParams({
    auth_date: String(input.authDate ?? Math.floor(NOW.getTime() / 1_000)),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify(user),
  });
  if (input.startParam !== undefined) fields.set('start_param', input.startParam);
  const dataCheckString = [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData')
    .update(input.botToken ?? BOT_TOKEN)
    .digest();
  fields.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return fields.toString();
}

function engineResponding(status: number, body: unknown) {
  return vi.fn(async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  ));
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function dependencies(fetchImpl: typeof fetch) {
  return { config: CONFIG, fetchImpl, now: () => NOW };
}

describe('Mini App position open boundary', () => {
  it('mints a placement session through the engine with the exact shared contract', async () => {
    const fetchImpl = engineResponding(200, { token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO });
    const initData = signedInitData({ startParam: `p-${MARKET_HEX}-b`, username: 'callie_fan' });

    const result = await openMiniAppPositionSession({ initData }, dependencies(fetchImpl));

    expect(result).toEqual({
      status: 200,
      body: { token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://engine.example.test/api/escrow/positions/session');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      authorization: `Bearer ${ENGINE_TOKEN}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      marketId: MARKET_ID,
      side: 'back',
      amountPreset: 0,
      telegramUserId: 42,
      telegramUsername: 'callie_fan',
      idempotencyKey: sha256Hex(`miniapp:42:${MARKET_ID}:back:${BUCKET}`),
    });
  });

  it('maps the d side code to against', async () => {
    const fetchImpl = engineResponding(200, { token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO });
    const initData = signedInitData({ startParam: `p-${MARKET_HEX}-d` });

    const result = await openMiniAppPositionSession({ initData }, dependencies(fetchImpl));

    expect(result.status).toBe(200);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload.side).toBe('against');
    expect(payload.idempotencyKey).toBe(sha256Hex(`miniapp:42:${MARKET_ID}:against:${BUCKET}`));
    expect(payload).not.toHaveProperty('telegramUsername');
  });

  it('ignores client-supplied market fields and reads only the signed start_param', async () => {
    const fetchImpl = engineResponding(200, { token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO });
    const initData = signedInitData({ startParam: `p-${MARKET_HEX}-b` });

    const result = await openMiniAppPositionSession(
      { initData, marketId: '11111111-1111-4111-8111-111111111111', side: 'against' },
      dependencies(fetchImpl),
    );

    expect(result).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects initData without a position start_param before touching the engine', async () => {
    const fetchImpl = engineResponding(200, { token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO });
    for (const startParam of [undefined, 'group-invite', `p-${MARKET_HEX}-x`]) {
      const result = await openMiniAppPositionSession(
        { initData: signedInitData({ startParam }) },
        dependencies(fetchImpl),
      );
      expect(result).toEqual({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects tampered or stale initData before touching the engine', async () => {
    const fetchImpl = engineResponding(200, { token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO });
    const tampered = signedInitData({
      startParam: `p-${MARKET_HEX}-b`,
      botToken: 'different:bot-token',
    });
    const stale = signedInitData({
      startParam: `p-${MARKET_HEX}-b`,
      authDate: Math.floor(NOW.getTime() / 1_000) - 301,
    });
    for (const initData of [tampered, stale]) {
      const result = await openMiniAppPositionSession({ initData }, dependencies(fetchImpl));
      expect(result).toEqual({ status: 401, body: { error: 'telegram_auth_required' } });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses outside escrow custody', async () => {
    const fetchImpl = engineResponding(200, { token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO });
    const result = await openMiniAppPositionSession(
      { initData: signedInitData({ startParam: `p-${MARKET_HEX}-b` }) },
      { config: { ...CONFIG, custodyMode: 'legacy' }, fetchImpl, now: () => NOW },
    );
    expect(result).toEqual({ status: 404, body: { error: 'escrow_not_enabled' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards each contract error code with its own status', async () => {
    const cases = [
      ['wallet_required', 409],
      ['market_not_found', 404],
      ['market_closed', 410],
      ['positions_paused', 409],
      ['rate_limited', 429],
      ['invalid_request', 400],
    ] as const;
    for (const [code, status] of cases) {
      const result = await openMiniAppPositionSession(
        { initData: signedInitData({ startParam: `p-${MARKET_HEX}-b` }) },
        dependencies(engineResponding(400, { error: code })),
      );
      expect(result, code).toEqual({ status, body: { error: code } });
    }
  });

  it('collapses unknown engine errors and malformed successes into sponsor_unavailable', async () => {
    const unknownCode = await openMiniAppPositionSession(
      { initData: signedInitData({ startParam: `p-${MARKET_HEX}-b` }) },
      dependencies(engineResponding(500, { error: 'treasury_on_fire' })),
    );
    expect(unknownCode).toEqual({ status: 502, body: { error: 'sponsor_unavailable' } });

    const malformedError = await openMiniAppPositionSession(
      { initData: signedInitData({ startParam: `p-${MARKET_HEX}-b` }) },
      dependencies(engineResponding(500, 'not-json')),
    );
    expect(malformedError).toEqual({ status: 502, body: { error: 'sponsor_unavailable' } });

    const malformedSession = await openMiniAppPositionSession(
      { initData: signedInitData({ startParam: `p-${MARKET_HEX}-b` }) },
      dependencies(engineResponding(200, { token: 'short', expiresAtIso: EXPIRES_AT_ISO })),
    );
    expect(malformedSession).toEqual({ status: 502, body: { error: 'sponsor_unavailable' } });
  });

  it('reports an unreachable engine as service unavailability', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const result = await openMiniAppPositionSession(
      { initData: signedInitData({ startParam: `p-${MARKET_HEX}-b` }) },
      dependencies(fetchImpl as unknown as typeof fetch),
    );
    expect(result).toEqual({ status: 503, body: { error: 'sponsor_unavailable' } });
  });

  it('keeps the idempotency key stable inside a 30-second bucket and rotates after it', () => {
    const base = miniAppPositionIdempotencyKey({
      telegramUserId: 42,
      marketId: MARKET_ID,
      side: 'back',
      now: NOW,
    });
    const sameBucket = miniAppPositionIdempotencyKey({
      telegramUserId: 42,
      marketId: MARKET_ID,
      side: 'back',
      now: new Date(NOW.getTime() + 29_999),
    });
    const nextBucket = miniAppPositionIdempotencyKey({
      telegramUserId: 42,
      marketId: MARKET_ID,
      side: 'back',
      now: new Date(NOW.getTime() + 30_000),
    });
    expect(base).toBe(sha256Hex(`miniapp:42:${MARKET_ID}:back:${BUCKET}`));
    expect(sameBucket).toBe(base);
    expect(nextBucket).not.toBe(base);
  });
});

describe('Mini App wallet open boundary', () => {
  it('mints a wallet-link session with the exact shared contract', async () => {
    const fetchImpl = engineResponding(200, { token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO });
    const result = await openMiniAppWalletSession(
      { initData: signedInitData({ username: 'callie_fan' }) },
      dependencies(fetchImpl),
    );

    expect(result).toEqual({
      status: 200,
      body: { token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://engine.example.test/api/escrow/wallet/session');
    expect(init.headers).toEqual({
      authorization: `Bearer ${ENGINE_TOKEN}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      telegramUserId: 42,
      telegramUsername: 'callie_fan',
      idempotencyKey: sha256Hex(`miniapp-wallet:42:${BUCKET}`),
    });
  });

  it('opens without any start_param and without a username', async () => {
    const fetchImpl = engineResponding(200, { token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO });
    const result = await openMiniAppWalletSession(
      { initData: signedInitData() },
      dependencies(fetchImpl),
    );
    expect(result.status).toBe(200);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      telegramUserId: 42,
      idempotencyKey: sha256Hex(`miniapp-wallet:42:${BUCKET}`),
    });
  });

  it('forwards only the wallet contract error codes', async () => {
    const invalidRequest = await openMiniAppWalletSession(
      { initData: signedInitData() },
      dependencies(engineResponding(400, { error: 'invalid_request' })),
    );
    expect(invalidRequest).toEqual({ status: 400, body: { error: 'invalid_request' } });

    const rateLimited = await openMiniAppWalletSession(
      { initData: signedInitData() },
      dependencies(engineResponding(429, { error: 'rate_limited' })),
    );
    expect(rateLimited).toEqual({ status: 429, body: { error: 'rate_limited' } });

    const positionOnlyCode = await openMiniAppWalletSession(
      { initData: signedInitData() },
      dependencies(engineResponding(400, { error: 'market_closed' })),
    );
    expect(positionOnlyCode).toEqual({ status: 502, body: { error: 'sponsor_unavailable' } });
  });

  it('rotates the wallet idempotency key across buckets', () => {
    const base = miniAppWalletIdempotencyKey({ telegramUserId: 42, now: NOW });
    expect(base).toBe(sha256Hex(`miniapp-wallet:42:${BUCKET}`));
    expect(miniAppWalletIdempotencyKey({
      telegramUserId: 42,
      now: new Date(NOW.getTime() + 30_000),
    })).not.toBe(base);
  });
});
