import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestWalletAuthSession,
  WalletClientError,
  walletClientErrorMessage,
} from './wallet-client';

describe('wallet auth client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchanges only the private link token for a short-lived external JWT', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      jwt: 'signed-external-wallet-jwt',
      expiresAt: '2026-07-14T12:00:00.000Z',
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestWalletAuthSession('A'.repeat(43))).resolves.toEqual({
      jwt: 'signed-external-wallet-jwt',
      expiresAt: '2026-07-14T12:00:00.000Z',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/wallet/session', expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
      body: JSON.stringify({ token: 'A'.repeat(43) }),
    }));
  });

  it('returns a clear expired-link error without exposing provider details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'wallet_link_expired' }),
      { status: 410, headers: { 'content-type': 'application/json' } },
    )));

    const request = requestWalletAuthSession('A'.repeat(43));
    await expect(request).rejects.toEqual(new WalletClientError('wallet_link_expired'));
    await request.catch((error: unknown) => {
      expect(walletClientErrorMessage(error)).toBe(
        'This private link expired. Return to Telegram and open /wallet again.',
      );
    });
  });
});
