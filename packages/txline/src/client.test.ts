import { describe, expect, it, vi } from 'vitest';
import { activateToken, startGuestAuth, TxlineApiError, TxlineClient } from './client.js';
import { silentLogger } from './logging.js';
import { fixtureRecord, oddsRecord, scoresRecord } from './test-fixtures.js';

const API_BASE = 'https://txline-dev.example.test';
const GUEST_JWT = 'jwt-guest-1';
const API_TOKEN = 'txoracle_api_test';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function mockFetch(
  responder: (call: RecordedCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      ),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const makeClient = (fetchImpl: typeof fetch): TxlineClient =>
  new TxlineClient({ apiBase: API_BASE, guestJwt: GUEST_JWT, apiToken: API_TOKEN, fetchImpl, logger: silentLogger });

describe('TxlineClient snapshots', () => {
  it('sends dual auth headers and the asOf query on scoresSnapshot', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse([scoresRecord()]));
    const records = await makeClient(fetchImpl).scoresSnapshot(42, 1_780_000_000_000);
    expect(records).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API_BASE}/api/scores/snapshot/42?asOf=1780000000000`);
    expect(calls[0]?.headers['Authorization']).toBe(`Bearer ${GUEST_JWT}`);
    expect(calls[0]?.headers['X-Api-Token']).toBe(API_TOKEN);
  });

  it('omits asOf when not provided', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse([]));
    await makeClient(fetchImpl).oddsSnapshot(7);
    expect(calls[0]?.url).toBe(`${API_BASE}/api/odds/snapshot/7`);
  });

  it('parses odds snapshots', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse([oddsRecord()]));
    const records = await makeClient(fetchImpl).oddsSnapshot(7, 123);
    expect(records[0]?.MessageId).toBe('msg-1');
  });

  it('passes fixtures snapshot params', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse([fixtureRecord()]));
    await makeClient(fetchImpl).fixturesSnapshot({ startEpochDay: 20642, competitionId: 501 });
    expect(calls[0]?.url).toBe(
      `${API_BASE}/api/fixtures/snapshot?startEpochDay=20642&competitionId=501`,
    );
  });

  it('throws a descriptive error on HTTP failure', async () => {
    const { fetchImpl } = mockFetch(
      () => new Response('Access denied: Invalid API token', { status: 403 }),
    );
    const error = await makeClient(fetchImpl)
      .scoresSnapshot(42)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TxlineApiError);
    expect((error as TxlineApiError).status).toBe(403);
    expect((error as TxlineApiError).message).toContain('HTTP 403');
    expect((error as TxlineApiError).message).toContain('Access denied');
    expect((error as TxlineApiError).message).toContain('/api/scores/snapshot/42');
  });

  it('throws a descriptive error when a snapshot body is not an array', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ message: 'not an array' }));
    const error = await makeClient(fetchImpl)
      .oddsSnapshot(7)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TxlineApiError);
    expect((error as TxlineApiError).message).toContain('unexpected response shape');
  });

  it('skips malformed snapshot records instead of rejecting the response', async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse([{ FixtureId: 'not-a-number' }, oddsRecord()]),
    );
    const records = await makeClient(fetchImpl).oddsSnapshot(7);
    expect(records).toHaveLength(1);
    expect(records[0]?.MessageId).toBe('msg-1');
  });

  it('accepts explicit nulls in optional odds fields (live devnet shape)', async () => {
    // Observed 2026-07-03 on /api/odds/snapshot: GameState/MarketParameters
    // arrive as JSON null; one such record must not zero out pricing.
    const { fetchImpl } = mockFetch(() =>
      jsonResponse([{ ...oddsRecord(), GameState: null, MarketParameters: null }]),
    );
    const records = await makeClient(fetchImpl).oddsSnapshot(7);
    expect(records).toHaveLength(1);
    expect(records[0]?.GameState).toBeUndefined();
    expect(records[0]?.MarketParameters).toBeUndefined();
  });
});

describe('TxlineClient validation endpoints', () => {
  it('requests stat validation with optional statKey2', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse({ ts: 1 }));
    const client = makeClient(fetchImpl);
    await client.statValidation(42, 17, 1);
    await client.statValidation(42, 17, 1, 5);
    expect(calls[0]?.url).toBe(`${API_BASE}/api/scores/stat-validation?fixtureId=42&seq=17&statKey=1`);
    expect(calls[1]?.url).toBe(
      `${API_BASE}/api/scores/stat-validation?fixtureId=42&seq=17&statKey=1&statKey2=5`,
    );
  });

  it('requests odds validation by messageId and ts', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse({ odds: {} }));
    await makeClient(fetchImpl).oddsValidation('msg-9', 1_780_000_000_000);
    expect(calls[0]?.url).toBe(`${API_BASE}/api/odds/validation?messageId=msg-9&ts=1780000000000`);
  });
});

describe('TxlineClient.openStream', () => {
  it('sets stream headers including Last-Event-ID and the fixture filter', async () => {
    const { fetchImpl, calls } = mockFetch(
      () => new Response(new ReadableStream<Uint8Array>(), { status: 200 }),
    );
    const res = await makeClient(fetchImpl).openStream('scores', {
      fixtureId: 42,
      lastEventId: '1730000000000:5',
    });
    expect(res.body).not.toBeNull();
    expect(calls[0]?.url).toBe(`${API_BASE}/api/scores/stream?fixtureId=42`);
    expect(calls[0]?.headers['Accept']).toBe('text/event-stream');
    expect(calls[0]?.headers['Last-Event-ID']).toBe('1730000000000:5');
    expect(calls[0]?.headers['Authorization']).toBe(`Bearer ${GUEST_JWT}`);
    expect(calls[0]?.headers['X-Api-Token']).toBe(API_TOKEN);
  });

  it('omits Last-Event-ID on a fresh connect and hits the odds stream path', async () => {
    const { fetchImpl, calls } = mockFetch(
      () => new Response(new ReadableStream<Uint8Array>(), { status: 200 }),
    );
    await makeClient(fetchImpl).openStream('odds');
    expect(calls[0]?.url).toBe(`${API_BASE}/api/odds/stream`);
    expect(calls[0]?.headers['Last-Event-ID']).toBeUndefined();
  });
});

describe('auth helpers', () => {
  it('startGuestAuth POSTs and unwraps the token', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse({ token: 'jwt-fresh' }));
    const { jwt } = await startGuestAuth(API_BASE, fetchImpl);
    expect(jwt).toBe('jwt-fresh');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${API_BASE}/auth/guest/start`);
  });

  it('activateToken sends the signed payload and accepts a text/plain token', async () => {
    const { fetchImpl, calls } = mockFetch(
      () => new Response('txoracle_api_123abc', { status: 200 }),
    );
    const { apiToken } = await activateToken(
      API_BASE,
      GUEST_JWT,
      'tx-sig-1',
      'c2lnbmF0dXJl',
      [501, 804],
      fetchImpl,
    );
    expect(apiToken).toBe('txoracle_api_123abc');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${API_BASE}/api/token/activate`);
    expect(calls[0]?.headers['Authorization']).toBe(`Bearer ${GUEST_JWT}`);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      txSig: 'tx-sig-1',
      walletSignature: 'c2lnbmF0dXJl',
      leagues: [501, 804],
    });
  });

  it('activateToken tolerates JSON-wrapped tokens', async () => {
    const quoted = mockFetch(() => new Response('"quoted-token"', { status: 200 }));
    expect(
      (await activateToken(API_BASE, GUEST_JWT, 'tx', 'sig', [], quoted.fetchImpl)).apiToken,
    ).toBe('quoted-token');

    const wrapped = mockFetch(() => jsonResponse({ token: 'object-token' }));
    expect(
      (await activateToken(API_BASE, GUEST_JWT, 'tx', 'sig', [], wrapped.fetchImpl)).apiToken,
    ).toBe('object-token');
  });

  it('activateToken surfaces HTTP failures descriptively', async () => {
    const { fetchImpl } = mockFetch(
      () => new Response('Authorization failed: Invalid or expired guest JWT.', { status: 401 }),
    );
    const error = await activateToken(API_BASE, GUEST_JWT, 'tx', 'sig', [], fetchImpl).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TxlineApiError);
    expect((error as TxlineApiError).message).toContain('HTTP 401');
  });
});

describe('late-bound default fetch', () => {
  it('uses globalThis.fetch stubs applied after construction', async () => {
    const client = new TxlineClient({
      apiBase: API_BASE,
      guestJwt: GUEST_JWT,
      apiToken: API_TOKEN,
      logger: silentLogger,
    });
    const stub = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse([]) as unknown as Awaited<ReturnType<typeof fetch>>);
    try {
      await client.oddsSnapshot(1);
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      stub.mockRestore();
    }
  });
});
