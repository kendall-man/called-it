import { describe, expect, it } from 'vitest';
import { parsePositionSigningSession, PositionAuthorizationSchema } from './position-contract';
import { positionServerFixture } from './position-test-fixture';
import { signingSessionRpcArguments } from './position-store';

describe('escrow signing-session contract', () => {
  it('parses the exact migration 0024 service-role RPC shape', () => {
    const fixture = positionServerFixture();
    const parsed = parsePositionSigningSession({
      ok: true,
      state: 'pending',
      user_id: '42',
      provider_user_id: fixture.identity.privyUserId,
      provider_wallet_id: fixture.identity.walletId,
      owner_pubkey: fixture.identity.pubkey,
      market_id: fixture.session.marketId,
      side: 'back',
      asset: 'sol',
      amount_atomic: '10000000',
      lot_nonce: '3',
      event_epoch: '2',
      document_hash_hex: fixture.session.documentHashHex,
      transaction_message_hash_hex: fixture.session.transactionMessageHashHex,
      raw_transaction_base64: fixture.session.rawTransactionBase64,
      authorization: fixture.authorization,
      transaction_signature: null,
      expires_at: fixture.session.expiresAt.replace('Z', '+00:00'),
    });

    expect(parsed).toMatchObject({
      userId: 42,
      amountAtomic: 10_000_000n,
      lotNonce: 3n,
      eventEpoch: 2n,
    });
  });

  it('rejects rounded JSON numbers for every protocol-sized authorization field', () => {
    const fixture = positionServerFixture();
    for (const key of [
      'amount',
      'expectedRatioMilli',
      'expectedEventEpoch',
      'expectedLotNonce',
      'expiresAt',
      'lastValidBlockHeight',
    ] as const) {
      expect(PositionAuthorizationSchema.safeParse({
        ...fixture.authorization,
        [key]: Number(fixture.authorization[key]),
      }).success).toBe(false);
    }
  });

  it('calls the committed two-argument service-role RPC contract', () => {
    expect(signingSessionRpcArguments('ab'.repeat(32), new Date('2030-01-01T00:00:00.000Z'))).toEqual({
      p_token_hash_hex: 'ab'.repeat(32),
      p_now: '2030-01-01T00:00:00.000Z',
    });
  });
});
