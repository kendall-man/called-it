import { describe, expect, it } from 'vitest';
import {
  PrivyIdentityError,
  isPrivySessionOwner,
  readPrivyBearerToken,
  resolvePrivyWalletIdentity,
} from './privy-server';

const USER = {
  id: 'did:privy:called-it-user',
  linked_accounts: [
    { type: 'custom_auth', custom_user_id: 'calledit:devnet:telegram:123456789' },
    {
      type: 'wallet',
      id: 'wallet-01',
      address: '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
      chain_type: 'solana',
      connector_type: 'embedded',
      wallet_client_type: 'privy',
    },
  ],
};

describe('Privy wallet identity', () => {
  it('accepts only a bearer access token', () => {
    expect(readPrivyBearerToken('Bearer privy-access-token-with-length')).toBe(
      'privy-access-token-with-length',
    );
    expect(readPrivyBearerToken('Basic privy-access-token-with-length')).toBeNull();
    expect(readPrivyBearerToken(null)).toBeNull();
  });

  it('binds the verified Privy user, Telegram account, and embedded Solana wallet', () => {
    const identity = resolvePrivyWalletIdentity(
      USER,
      'did:privy:called-it-user',
      '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
      'devnet',
    );

    expect(identity).toEqual({
      privyUserId: 'did:privy:called-it-user',
      telegramUserId: '123456789',
      walletId: 'wallet-01',
      pubkey: '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
    });
  });

  it('rejects recovery-method labels used as a wallet client type', () => {
    const malformedUser = {
      ...USER,
      linked_accounts: USER.linked_accounts.map((account) => (
        account.type === 'wallet' ? { ...account, wallet_client_type: 'privy-v2' } : account
      )),
    };

    expect(() => resolvePrivyWalletIdentity(
      malformedUser,
      USER.id,
      '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
      'devnet',
    )).toThrowError(new PrivyIdentityError('wallet_not_owned'));
  });

  it('rejects a token subject that does not match the fetched Privy user', () => {
    expect(() => resolvePrivyWalletIdentity(
      USER,
      'did:privy:another-user',
      '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
      'devnet',
    )).toThrowError(new PrivyIdentityError('identity_mismatch'));
  });

  it('rejects external or non-Privy Solana wallets', () => {
    const externalWalletUser = {
      ...USER,
      linked_accounts: USER.linked_accounts.map((account) => (
        account.type === 'wallet' ? { ...account, connector_type: 'injected' } : account
      )),
    };

    expect(() => resolvePrivyWalletIdentity(
      externalWalletUser,
      USER.id,
      '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
      'devnet',
    )).toThrowError(new PrivyIdentityError('wallet_not_owned'));
  });

  it('matches the Privy custom-auth subject to the one-time bot session owner', () => {
    const identity = resolvePrivyWalletIdentity(
      USER,
      USER.id,
      '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
      'devnet',
    );

    expect(isPrivySessionOwner(identity, 123_456_789)).toBe(true);
    expect(isPrivySessionOwner(identity, 123_456_790)).toBe(false);
  });

  it('rejects a custom-auth subject from the other Solana network', () => {
    expect(() => resolvePrivyWalletIdentity(
      USER,
      USER.id,
      '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
      'mainnet-beta',
    )).toThrowError(new PrivyIdentityError('identity_mismatch'));
  });

  it('uses the Solana address as a stable ID for legacy Privy wallets', () => {
    const legacyUser = {
      ...USER,
      linked_accounts: USER.linked_accounts.map((account) => (
        account.type === 'wallet' ? { ...account, id: null } : account
      )),
    };

    const identity = resolvePrivyWalletIdentity(
      legacyUser,
      USER.id,
      '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
      'devnet',
    );

    expect(identity.walletId).toBe(
      'solana:38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
    );
  });
});
