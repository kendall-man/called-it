import { describe, expect, it } from 'vitest';
import {
  getWalletAccountSummary,
  type WalletAccountStore,
} from './wallet-account-server';
import { PrivyIdentityError, type PrivyIdentityVerifier } from './privy-server';

const PUBKEY = '2Qc7GtNAva3nG9dBk2YKtb1sFdb5pmrQ9hL2Ls62ahqc';
const USER_ID = 9799224252;

const identity: PrivyIdentityVerifier = async () => ({
  privyUserId: 'did:privy:test',
  telegramUserId: String(USER_ID),
  walletId: 'wallet-test',
  pubkey: PUBKEY,
});

const store: WalletAccountStore = {
  async summary(userId, pubkey) {
    expect(userId).toBe(USER_ID);
    expect(pubkey).toBe(PUBKEY);
    return { availableLamports: 25_000_000n, lockedLamports: 10_000_000n };
  },
};

describe('private wallet account summary', () => {
  it('returns string lamports only after Privy identity verification', async () => {
    await expect(getWalletAccountSummary(
      { pubkey: PUBKEY },
      'access-token-value',
      identity,
      store,
    )).resolves.toEqual({
      status: 200,
      body: {
        balances: {
          sol: { availableAtomic: '25000000', lockedAtomic: '10000000' },
          usdc: { availableAtomic: '0', lockedAtomic: '0' },
        },
        availableLamports: '25000000',
        lockedLamports: '10000000',
      },
    });
  });

  it('rejects an invalid Privy identity before reading account data', async () => {
    let reads = 0;
    const rejectedStore: WalletAccountStore = {
      async summary() {
        reads += 1;
        return null;
      },
    };
    const rejected: PrivyIdentityVerifier = async () => {
      throw new PrivyIdentityError('identity_mismatch');
    };
    await expect(getWalletAccountSummary(
      { pubkey: PUBKEY },
      'access-token-value',
      rejected,
      rejectedStore,
    )).resolves.toEqual({ status: 403, body: { error: 'privy_identity_invalid' } });
    expect(reads).toBe(0);
  });
});
