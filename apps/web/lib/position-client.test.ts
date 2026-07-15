import { afterEach, describe, expect, it, vi } from 'vitest';
import { PositionClientError, requestPositionAuthSession } from './position-client';

const TOKEN = 'a'.repeat(43);

describe('escrow position auth client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends Telegram initData with the opaque position token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      jwt: 'signed-position-custom-auth-jwt',
      expiresAt: '2030-01-01T00:05:00.000Z',
      network: 'devnet',
    }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestPositionAuthSession(TOKEN, 'verified-by-server-init-data')).resolves.toMatchObject({
      network: 'devnet',
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({ token: TOKEN, initData: 'verified-by-server-init-data' });
  });

  it('fails closed before a request when Telegram initData is unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestPositionAuthSession(TOKEN, '')).rejects.toEqual(
      new PositionClientError('telegram_auth_required'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
