import {
  buildSponsoredPositionTransaction,
  ESCROW_PROGRAM_ID,
} from '@calledit/escrow-sdk';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import type { PrivyWalletIdentity } from './privy-server';
import type { PositionServerConfig } from './position-server';
import { transactionMessageHashHex } from './position-server';
import type { PositionStore } from './position-store';
import type { PositionAuthorization, PositionSigningSession } from './position-contract';

export const FIXTURE_NOW = new Date('2030-01-01T00:00:00.000Z');
export const FIXTURE_MARKET_ID = '8ec17c8a-2a30-4f08-9b75-7cbe565d568f';
export const FIXTURE_GENESIS = 'calledit-test-genesis';
export const FIXTURE_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const FIXTURE_TOKEN = 'a'.repeat(43);

export function positionServerFixture() {
  const sponsor = Keypair.generate();
  const owner = Keypair.generate();
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const expiresAt = BigInt(Math.floor(FIXTURE_NOW.getTime() / 1_000) + 300);
  const documentHash = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const built = buildSponsoredPositionTransaction({
    programId: ESCROW_PROGRAM_ID,
    relayerFeePayer: sponsor.publicKey,
    userWallet: owner.publicKey,
    canonicalUsdcMint: FIXTURE_USDC_MINT,
    marketUuid: FIXTURE_MARKET_ID,
    marketDocumentHash: documentHash,
    side: 'back',
    amount: 10_000_000n,
    asset: 'sol',
    expectedRatioMilli: 1_500,
    expectedEventEpoch: 2n,
    expectedLotNonce: 3n,
    expiresAt,
    genesisHash: FIXTURE_GENESIS,
    recentBlockhash,
    lastValidBlockHeight: 2_000n,
  });
  built.transaction.sign([sponsor]);
  const rawTransactionBase64 = Buffer.from(built.transaction.serialize()).toString('base64');
  const messageHashHex = transactionMessageHashHex(built.transaction);
  const authorization: PositionAuthorization = {
    schemaVersion: 1,
    programId: ESCROW_PROGRAM_ID,
    relayerFeePayer: sponsor.publicKey.toBase58(),
    canonicalUsdcMint: FIXTURE_USDC_MINT,
    marketUuid: FIXTURE_MARKET_ID,
    marketPda: built.intent.marketPda.toString(),
    marketDocumentHashHex: Buffer.from(documentHash).toString('hex'),
    side: 'back',
    amount: '10000000',
    asset: 'sol',
    expectedRatioMilli: '1500',
    expectedEventEpoch: '2',
    expectedLotNonce: '3',
    expiresAt: expiresAt.toString(),
    genesisHash: FIXTURE_GENESIS,
    recentBlockhash,
    lastValidBlockHeight: '2000',
    messageHashHex,
  };
  const identity: PrivyWalletIdentity = {
    telegramUserId: '42',
    privyUserId: 'did:privy:test-user',
    walletId: 'wallet-test',
    pubkey: owner.publicKey.toBase58(),
  };
  const session: PositionSigningSession = {
    state: 'pending',
    userId: 42,
    providerUserId: identity.privyUserId,
    providerWalletId: identity.walletId,
    ownerPubkey: identity.pubkey,
    marketId: FIXTURE_MARKET_ID,
    side: 'back',
    asset: 'sol',
    amountAtomic: 10_000_000n,
    lotNonce: 3n,
    eventEpoch: 2n,
    documentHashHex: authorization.marketDocumentHashHex,
    transactionMessageHashHex: messageHashHex,
    rawTransactionBase64,
    authorization,
    transactionSignature: null,
    expiresAt: new Date(Number(expiresAt) * 1_000).toISOString(),
  };
  const config: PositionServerConfig = {
    appId: 'clp_123456789012345678901',
    canonicalUsdcMint: FIXTURE_USDC_MINT,
    custodyMode: 'escrow',
    engineToken: 'web-bridge-token-with-more-than-32-bytes',
    engineUrl: 'https://engine.example.test',
    genesisHash: FIXTURE_GENESIS,
    issuer: 'https://web.example.test',
    keyId: 'test-key',
    network: 'devnet',
    privateKeyBase64: 'unused-in-injected-tests',
    programId: ESCROW_PROGRAM_ID,
    rpcUrl: 'https://rpc.example.test',
  };
  const store: PositionStore = {
    async readSession() { return { kind: 'found', session }; },
    async displayTerms() { return 'France to win'; },
    async indexedStatus() {
      return { stage: 'awaiting_signature', signature: null, positionState: null, commitment: null };
    },
    async accountPositions() { return []; },
  };
  return {
    authorization,
    built,
    config,
    identity,
    owner,
    session,
    sponsor,
    store,
    dependencies: {
      config,
      store,
      now: () => FIXTURE_NOW,
      chain: {
        async genesisHash() { return FIXTURE_GENESIS; },
        async blockHeight() { return 100n; },
        async blockhashValid() { return true; },
      },
      async verifyIdentity() { return identity; },
    },
  };
}
export function signedFixtureTransaction(
  rawTransactionBase64: string,
  owner: Keypair,
): VersionedTransaction {
  const transaction = VersionedTransaction.deserialize(Buffer.from(rawTransactionBase64, 'base64'));
  transaction.sign([owner]);
  return transaction;
}
