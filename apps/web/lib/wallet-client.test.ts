import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  linkPrivyWallet,
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

  it('signs the complete server challenge response before verifying the wallet', async () => {
    const challengeId = '00000000-0000-4000-8000-000000000111';
    const expiresAt = '2026-07-14T12:00:00.000Z';
    const signature = Uint8Array.from({ length: 64 }, (_, index) => index);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challengeId,
        expiresAt,
        message: 'Called It wallet ownership challenge',
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        wallet: {
          status: 'verified',
          pubkey: '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const signMessage = vi.fn(async () => signature);
    vi.stubGlobal('fetch', fetchMock);

    await expect(linkPrivyWallet({
      sessionToken: 'A'.repeat(43),
      accessToken: 'privy-access-token-with-length',
      pubkey: '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
      signMessage,
    })).resolves.toBeUndefined();

    expect(signMessage).toHaveBeenCalledWith(
      new TextEncoder().encode('Called It wallet ownership challenge'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/wallet/verify');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      token: 'A'.repeat(43),
      pubkey: '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
      challengeId,
      signatureHex: Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    });
  });
});
