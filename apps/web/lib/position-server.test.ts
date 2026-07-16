import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import type { PrivyWalletIdentity } from './privy-server';
import {
  createPositionAuthSession,
  getEscrowAccountPositions,
  getEscrowPositionStatus,
  prepareEscrowPosition,
  submitEscrowPosition,
} from './position-server';
import {
  FIXTURE_INIT_DATA,
  FIXTURE_TOKEN,
  positionServerFixture,
  signedFixtureTransaction,
} from './position-test-fixture';
import type { PositionSigningSession } from './position-contract';
import type { PositionStore } from './position-store';

function withSession(
  base: PositionStore,
  session: PositionSigningSession,
): PositionStore {
  return {
    ...base,
    async readSession() { return { kind: 'found', session }; },
  };
}

describe('escrow position server boundary', () => {
  it('issues custom auth without disclosing transaction or provider bindings', async () => {
    const fixture = positionServerFixture();
    const result = await createPositionAuthSession({ token: FIXTURE_TOKEN, initData: FIXTURE_INIT_DATA }, {
      ...fixture.dependencies,
      async signAuthJwt(userId, expiresAt) {
        expect(userId).toBe(42);
        expect(expiresAt).toBe(Date.parse(fixture.session.expiresAt));
        return 'signed-position-custom-auth-jwt';
      },
    });

    expect(result.status).toBe(201);
    expect(result.body).toEqual({
      jwt: 'signed-position-custom-auth-jwt',
      expiresAt: fixture.session.expiresAt,
      network: 'devnet',
    });
    expect(JSON.stringify(result.body)).not.toContain('rawTransaction');
    expect(JSON.stringify(result.body)).not.toContain('provider');
  });

  it('does not extend custom auth beyond the immutable signing-session expiry', async () => {
    const fixture = positionServerFixture();
    const expiresAt = fixture.dependencies.now().getTime() + 10_001;
    const session: PositionSigningSession = {
      ...fixture.session,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const signAuthJwt = vi.fn(async (_userId: number, jwtExpiresAt: number) => {
      expect(jwtExpiresAt).toBe(expiresAt);
      return 'short-lived-custom-auth-jwt';
    });

    const result = await createPositionAuthSession({ token: FIXTURE_TOKEN, initData: FIXTURE_INIT_DATA }, {
      ...fixture.dependencies,
      store: withSession(fixture.store, session),
      signAuthJwt,
    });

    expect(result).toEqual({
      status: 201,
      body: {
        jwt: 'short-lived-custom-auth-jwt',
        expiresAt: session.expiresAt,
        network: 'devnet',
      },
    });
    expect(signAuthJwt).toHaveBeenCalledWith(42, expiresAt);
  });

  it('rejects consumed signing URL replay without minting fresh auth', async () => {
    const fixture = positionServerFixture();
    const consumedSession: PositionSigningSession = {
      ...fixture.session,
      state: 'consumed',
      transactionSignature: '1'.repeat(64),
    };
    const signAuthJwt = vi.fn().mockResolvedValue('must-not-be-minted');
    const result = await createPositionAuthSession({ token: FIXTURE_TOKEN, initData: FIXTURE_INIT_DATA }, {
      ...fixture.dependencies,
      store: withSession(fixture.store, consumedSession),
      signAuthJwt,
    });

    expect(result).toEqual({ status: 409, body: { error: 'session_consumed' } });
    expect(signAuthJwt).not.toHaveBeenCalled();
  });

  it('rejects cancelled signing URLs without minting fresh auth', async () => {
    const fixture = positionServerFixture();
    const signAuthJwt = vi.fn().mockResolvedValue('must-not-be-minted');
    const store: PositionStore = {
      ...fixture.store,
      async readSession() {
        return { kind: 'rejected', code: 'session_consumed' };
      },
    };

    const result = await createPositionAuthSession({ token: FIXTURE_TOKEN, initData: FIXTURE_INIT_DATA }, {
      ...fixture.dependencies,
      store,
      signAuthJwt,
    });

    expect(result).toEqual({ status: 409, body: { error: 'session_consumed' } });
    expect(signAuthJwt).not.toHaveBeenCalled();
  });

  it('rejects expired pending signing URLs without minting fresh auth', async () => {
    const fixture = positionServerFixture();
    const expiredSession: PositionSigningSession = {
      ...fixture.session,
      expiresAt: new Date(fixture.dependencies.now().getTime() - 1).toISOString(),
    };
    const signAuthJwt = vi.fn().mockResolvedValue('must-not-be-minted');

    const result = await createPositionAuthSession({ token: FIXTURE_TOKEN, initData: FIXTURE_INIT_DATA }, {
      ...fixture.dependencies,
      store: withSession(fixture.store, expiredSession),
      signAuthJwt,
    });

    expect(result).toEqual({ status: 410, body: { error: 'session_expired' } });
    expect(signAuthJwt).not.toHaveBeenCalled();
  });

  it('rejects missing Telegram initData before minting Privy auth', async () => {
    const fixture = positionServerFixture();
    const signAuthJwt = vi.fn().mockResolvedValue('must-not-be-minted');

    const result = await createPositionAuthSession({ token: FIXTURE_TOKEN }, {
      ...fixture.dependencies,
      signAuthJwt,
    });

    expect(result).toEqual({ status: 401, body: { error: 'telegram_auth_required' } });
    expect(signAuthJwt).not.toHaveBeenCalled();
  });

  it('rejects invalid or expired Telegram initData before minting Privy auth', async () => {
    const fixture = positionServerFixture();
    const signAuthJwt = vi.fn().mockResolvedValue('must-not-be-minted');

    const result = await createPositionAuthSession({
      token: FIXTURE_TOKEN,
      initData: 'invalid-or-expired-init-data',
    }, {
      ...fixture.dependencies,
      signAuthJwt,
      verifyTelegramInitData() { throw new Error('invalid'); },
    });

    expect(result).toEqual({ status: 401, body: { error: 'telegram_auth_required' } });
    expect(signAuthJwt).not.toHaveBeenCalled();
  });

  it('rejects valid Telegram initData for another user before minting Privy auth', async () => {
    const fixture = positionServerFixture();
    const signAuthJwt = vi.fn().mockResolvedValue('must-not-be-minted');

    const result = await createPositionAuthSession({
      token: FIXTURE_TOKEN,
      initData: FIXTURE_INIT_DATA,
    }, {
      ...fixture.dependencies,
      signAuthJwt,
      verifyTelegramInitData() { return { telegramUserId: 43 }; },
    });

    expect(result).toEqual({ status: 403, body: { error: 'identity_mismatch' } });
    expect(signAuthJwt).not.toHaveBeenCalled();
  });

  it('prepares only after identity, sponsor signature, and exact message verification', async () => {
    const fixture = positionServerFixture();
    const result = await prepareEscrowPosition({
      token: FIXTURE_TOKEN,
      pubkey: fixture.identity.pubkey,
    }, 'privy-access-token-for-tests', fixture.dependencies);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      kind: 'prepared',
      rawTransactionBase64: fixture.session.rawTransactionBase64,
      authorization: fixture.authorization,
      terms: {
        title: 'France to win',
        choice: 'It happens',
        amountAtomic: '10000000',
      },
    });
    expect(result.body).not.toHaveProperty('providerUserId');
    expect(result.body).not.toHaveProperty('userId');
  });

  it.each([
    ['Telegram user', (identity: PrivyWalletIdentity) => ({ ...identity, telegramUserId: '43' })],
    ['Privy user', (identity: PrivyWalletIdentity) => ({ ...identity, privyUserId: 'did:privy:other' })],
    ['Privy wallet id', (identity: PrivyWalletIdentity) => ({ ...identity, walletId: 'wallet-other' })],
    ['wallet pubkey', (identity: PrivyWalletIdentity) => ({ ...identity, pubkey: Keypair.generate().publicKey.toBase58() })],
  ])('rejects a mismatched %s binding', async (_name, mutate) => {
    const fixture = positionServerFixture();
    const result = await prepareEscrowPosition({
      token: FIXTURE_TOKEN,
      pubkey: fixture.identity.pubkey,
    }, 'privy-access-token-for-tests', {
      ...fixture.dependencies,
      async verifyIdentity() { return mutate(fixture.identity); },
    });

    expect(result).toEqual({ status: 403, body: { error: 'identity_mismatch' } });
  });

  it.each([
    ['programId', (): string => Keypair.generate().publicKey.toBase58()],
    ['canonicalUsdcMint', (): string => Keypair.generate().publicKey.toBase58()],
    ['genesisHash', (): string => 'wrong-genesis'],
    ['marketUuid', (): string => 'a83c7ed8-ae1d-4f99-86e6-9e275e54d151'],
    ['marketPda', (): string => Keypair.generate().publicKey.toBase58()],
    ['side', (): string => 'doubt'],
    ['asset', (): string => 'usdc'],
    ['amount', (): string => '10000001'],
    ['expectedEventEpoch', (): string => '4'],
    ['expectedLotNonce', (): string => '5'],
    ['marketDocumentHashHex', (): string => 'a'.repeat(64)],
    ['messageHashHex', (): string => 'b'.repeat(64)],
    ['expiresAt', (): string => '1893456299'],
  ] as const)('rejects tampered authorization field %s before disclosure', async (field, value) => {
    const fixture = positionServerFixture();
    const session = {
      ...fixture.session,
      authorization: { ...fixture.authorization, [field]: value() },
    } as PositionSigningSession;
    const result = await prepareEscrowPosition({
      token: FIXTURE_TOKEN,
      pubkey: fixture.identity.pubkey,
    }, 'privy-access-token-for-tests', {
      ...fixture.dependencies,
      store: withSession(fixture.store, session),
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body).toHaveProperty('error');
  });

  it.each([
    ['relayerFeePayer', (): string => Keypair.generate().publicKey.toBase58()],
    ['expectedRatioMilli', (): string => '1501'],
    ['recentBlockhash', (): string => Keypair.generate().publicKey.toBase58()],
    ['lastValidBlockHeight', (): string => '1'],
  ] as const)('rejects message/validity tampering in %s', async (field, value) => {
    const fixture = positionServerFixture();
    const session = {
      ...fixture.session,
      authorization: { ...fixture.authorization, [field]: value() },
    } as PositionSigningSession;
    const result = await prepareEscrowPosition({
      token: FIXTURE_TOKEN,
      pubkey: fixture.identity.pubkey,
    }, 'privy-access-token-for-tests', {
      ...fixture.dependencies,
      store: withSession(fixture.store, session),
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body).toHaveProperty('error');
  });

  it('submits only server-derived identity fields and accepts duplicate-safe engine success', async () => {
    const fixture = positionServerFixture();
    const signed = signedFixtureTransaction(fixture.session.rawTransactionBase64, fixture.owner);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      kind: 'accepted',
      duplicate: true,
      jobCreated: false,
      signature: '1'.repeat(64),
    }));
    const result = await submitEscrowPosition({
      token: FIXTURE_TOKEN,
      pubkey: fixture.identity.pubkey,
      rawTransactionBase64: Buffer.from(signed.serialize()).toString('base64'),
    }, 'privy-access-token-for-tests', {
      ...fixture.dependencies,
      fetchImpl,
    });

    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ kind: 'accepted', duplicate: true });
    const request = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      telegramUserId: 42,
      privyUserId: fixture.identity.privyUserId,
      privyWalletId: fixture.identity.walletId,
      ownerPubkey: fixture.identity.pubkey,
      marketId: fixture.session.marketId,
    });
  });

  it('rejects browser-supplied identity fields instead of forwarding them', async () => {
    const fixture = positionServerFixture();
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await submitEscrowPosition({
      token: FIXTURE_TOKEN,
      pubkey: fixture.identity.pubkey,
      rawTransactionBase64: fixture.session.rawTransactionBase64,
      telegramUserId: 999,
    }, 'privy-access-token-for-tests', {
      ...fixture.dependencies,
      fetchImpl,
    });

    expect(result).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns an unknown state when the engine response is lost after submission', async () => {
    const fixture = positionServerFixture();
    const signed = signedFixtureTransaction(fixture.session.rawTransactionBase64, fixture.owner);
    const result = await submitEscrowPosition({
      token: FIXTURE_TOKEN,
      pubkey: fixture.identity.pubkey,
      rawTransactionBase64: Buffer.from(signed.serialize()).toString('base64'),
    }, 'privy-access-token-for-tests', {
      ...fixture.dependencies,
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('connection reset')),
    });

    expect(result).toEqual({ status: 503, body: { error: 'unknown_confirmation' } });
  });

  it('preserves authenticated status polling for a consumed session until expiry', async () => {
    const fixture = positionServerFixture();
    const consumedSession: PositionSigningSession = {
      ...fixture.session,
      state: 'consumed',
      transactionSignature: '1'.repeat(64),
    };
    const store: PositionStore = {
      ...withSession(fixture.store, consumedSession),
      async indexedStatus() {
        return {
          stage: 'finalized',
          signature: consumedSession.transactionSignature,
          positionState: 'active',
          commitment: 'finalized',
        };
      },
      async accountPositions() {
        return [{
          marketId: fixture.session.marketId,
          side: 'back',
          asset: 'sol',
          depositedAtomic: '10000000',
          pendingAtomic: '0',
          activeAtomic: '10000000',
          refundableAtomic: '0',
          claimedAtomic: '0',
          chainState: 'open',
          replay: false,
          claimState: 'open',
        }];
      },
    };
    const dependencies = { ...fixture.dependencies, store };
    const status = await getEscrowPositionStatus({
      token: FIXTURE_TOKEN,
      pubkey: fixture.identity.pubkey,
    }, 'privy-access-token-for-tests', dependencies);
    const account = await getEscrowAccountPositions({
      pubkey: fixture.identity.pubkey,
    }, 'privy-access-token-for-tests', dependencies);

    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ stage: 'finalized', commitment: 'finalized' });
    expect(account.body).toMatchObject({ positions: [{ claimState: 'open' }] });
  });
});
