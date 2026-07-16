import { describe, expect, it } from 'vitest';
import { createEscrowTelegramPort } from './telegram-port.js';
import type { EscrowPlacementService } from './placement-service.js';

const IDENTITY = {
  telegramUserId: 42,
  privyUserId: 'did:privy:user-42',
  privyWalletId: 'wallet-42',
  ownerPubkey: 'owner-pubkey',
};

describe('escrow Telegram runtime adapter', () => {
  it('binds private identity and exact callback terms into placement creation', async () => {
    const calls: unknown[] = [];
    const placement: EscrowPlacementService = {
      async create(input) {
        calls.push(input);
        return {
          kind: 'created', token: 'a'.repeat(43), rawTransactionBase64: 'raw',
          authorization: {
            programId: 'program', relayerFeePayer: 'payer', canonicalUsdcMint: 'mint',
            marketUuid: input.marketId, marketPda: 'market', marketDocumentHashHex: 'ab'.repeat(32),
            side: input.side, amount: input.amountAtomic, asset: 'sol', expectedRatioMilli: 1_500,
            expectedEventEpoch: 0n, expectedLotNonce: 0n, expiresAt: 1_700_000_300n,
            genesisHash: 'genesis', recentBlockhash: 'blockhash', lastValidBlockHeight: 2n,
            messageHashHex: 'cd'.repeat(32),
          },
        };
      },
      async present() { return { kind: 'rejected', code: 'session_not_found' }; },
      async accept() { return { kind: 'rejected', code: 'session_not_found' }; },
    };
    const port = createEscrowTelegramPort({
      placement,
      identities: { async resolve() { return IDENTITY; } },
      walletSessions: { async create() { return { kind: 'rejected', code: 'temporarily_unavailable' }; } },
      network: 'devnet',
      sessionTtlSeconds: 300,
    });

    await expect(port.createPlacementSession({
      idempotencyKey: 'callback-a', telegramUserId: 42, groupId: -100_123,
      marketId: '123e4567-e89b-12d3-a456-426614174000', side: 'back', asset: 'sol',
      amountAtomic: 25n, network: 'devnet', replay: true,
    })).resolves.toMatchObject({ kind: 'created', token: 'a'.repeat(43), duplicate: false });
    expect(calls).toEqual([{
      ...IDENTITY, groupId: -100_123, marketId: '123e4567-e89b-12d3-a456-426614174000',
      expectedAsset: 'sol', expectedReplay: true,
      side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    }]);
  });

  it('fails closed when no private Telegram to Privy identity exists', async () => {
    const port = createEscrowTelegramPort({
      placement: {} as EscrowPlacementService,
      identities: { async resolve() { return null; } },
      walletSessions: { async create() { return { kind: 'rejected', code: 'temporarily_unavailable' }; } },
      network: 'mainnet-beta',
      sessionTtlSeconds: 300,
    });

    await expect(port.createPlacementSession({
      idempotencyKey: 'callback-a', telegramUserId: 42, groupId: -100_123,
      marketId: '123e4567-e89b-12d3-a456-426614174000', side: 'back', asset: 'sol',
      amountAtomic: 25n, network: 'mainnet-beta', replay: false,
    })).resolves.toEqual({ kind: 'rejected', code: 'wallet_required' });
  });
});
