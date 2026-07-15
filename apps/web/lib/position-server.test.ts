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
import { FIXTURE_TOKEN, positionServerFixture, signedFixtureTransaction } from './position-test-fixture';
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
    const result = await createPositionAuthSession({ token: FIXTURE_TOKEN }, {
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

  it('issues a short recovery JWT for a consumed session after signing expiry', async () => {
    const fixture = positionServerFixture();
    const consumedSession: PositionSigningSession = {
      ...fixture.session,
      state: 'consumed',
      expiresAt: '2029-12-31T23:59:00.000Z',
      transactionSignature: '1'.repeat(64),
    };
    const result = await createPositionAuthSession({ token: FIXTURE_TOKEN }, {
      ...fixture.dependencies,
      store: withSession(fixture.store, consumedSession),
      async signAuthJwt(_userId, expiresAt) {
        expect(expiresAt).toBe(fixture.dependencies.now().getTime() + 5 * 60_000);
        return 'signed-recovery-custom-auth-jwt';
      },
    });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ jwt: 'signed-recovery-custom-auth-jwt' });
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

  it('returns canonical indexed status and private wallet positions after Privy verification', async () => {
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

    expect(status.body).toMatchObject({ stage: 'finalized', commitment: 'finalized' });
    expect(account.body).toMatchObject({ positions: [{ claimState: 'open' }] });
  });
});
