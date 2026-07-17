import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE_ENV } from '../env.test-fixtures.js';

type CapturedRequest = {
  readonly url: string;
  readonly init: RequestInit | undefined;
};

describe('engine API route credentials', () => {
  const captured: CapturedRequest[] = [];

  afterEach(() => {
    captured.length = 0;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses the concierge token for read-only engine calls', async () => {
    // Given the concierge has separate route-scoped engine credentials
    stubEnv();
    stubJsonFetch(captured, { group: { id: 42, title: 'N5' }, markets: [] });
    const { engineApi } = await import('./engine-api.js');

    // When it reads group state through the public client surface
    await engineApi.snapshot(42);

    // Then the request is sent to the private engine with the concierge token
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      url: 'http://engine.railway.internal:8790/api/groups/42/snapshot',
      init: expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: `Bearer ${BASE_ENV.ENGINE_CONCIERGE_TOKEN}`,
        }),
      }),
    });
  });

  it('forwards Telegram updates with only the Telegram ingress token', async () => {
    // Given a raw Telegram callback fixture and route-scoped credentials
    stubEnv();
    stubJsonFetch(captured, { ok: true });
    const { forwardTelegramUpdate } = await import('./engine-api.js');
    const update = {
      update_id: 123,
      callback_query: {
        id: 'callback-1',
        data: 'st:market:back:10000000',
      },
    };

    // When the concierge forwards the update to the engine ingress boundary
    await forwardTelegramUpdate(update);

    // Then it preserves the envelope and does not use the concierge token
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('http://engine.railway.internal:8790/api/telegram-ingress');
    expect(captured[0]?.init?.method).toBe('POST');
    expect(captured[0]?.init?.body).toBe(JSON.stringify(update));
    expect(captured[0]?.init?.headers).toMatchObject({
      authorization: `Bearer ${BASE_ENV.ENGINE_TELEGRAM_TOKEN}`,
      'content-type': 'application/json',
    });
  });

  it('does not reflect upstream bodies when engine calls fail', async () => {
    stubEnv();
    const fetchStub = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      captured.push({ url: String(input), init });
      return Response.json(
        {
          authorization: `Bearer ${BASE_ENV.ENGINE_CONCIERGE_TOKEN}`,
          initData: 'telegram-init-data',
          walletPrivateKey: 'wallet-secret-material',
          signature: 'signed-message-bytes',
        },
        { status: 500 },
      );
    };
    vi.stubGlobal('fetch', fetchStub);
    const { engineApi } = await import('./engine-api.js');

    await expect(engineApi.snapshot(42)).rejects.toThrow('engine api /api/groups/42/snapshot → 500');
    await expect(engineApi.snapshot(42)).rejects.not.toThrow(BASE_ENV.ENGINE_CONCIERGE_TOKEN);
    await expect(engineApi.snapshot(42)).rejects.not.toThrow('telegram-init-data');
    await expect(engineApi.snapshot(42)).rejects.not.toThrow('wallet-secret-material');
    await expect(engineApi.snapshot(42)).rejects.not.toThrow('signed-message-bytes');
  });
});

function stubJsonFetch(
  captured: CapturedRequest[],
  payload: unknown,
): void {
  const fetchStub = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    captured.push({ url: String(input), init });
    return Response.json(payload);
  };
  vi.stubGlobal('fetch', fetchStub);
}

function stubEnv(): void {
  for (const [name, value] of Object.entries(BASE_ENV)) {
    if (value !== undefined) {
      vi.stubEnv(name, value);
    }
  }
}
