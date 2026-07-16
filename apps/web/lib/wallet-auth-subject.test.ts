import { describe, expect, it } from 'vitest';
import { parseWalletAuthSubject, walletAuthSubject } from './wallet-auth-subject';

describe('wallet custom-auth subject', () => {
  it('round-trips a Telegram user within a Solana network', () => {
    const subject = walletAuthSubject('devnet', 123_456_789);
    expect(subject).toBe('calledit:devnet:telegram:123456789');
    expect(parseWalletAuthSubject(subject)).toEqual({
      network: 'devnet',
      telegramUserId: '123456789',
    });
  });

  it('keeps mainnet and devnet identities separate', () => {
    expect(walletAuthSubject('devnet', 42)).not.toBe(
      walletAuthSubject('mainnet-beta', 42),
    );
  });

  it.each([
    '',
    'calledit:devnet:telegram:0',
    'calledit:testnet:telegram:123',
    'calledit:devnet:telegram:not-a-number',
    'calledit:devnet:telegram:99999999999999999999',
  ])('rejects malformed subject %j', (subject) => {
    expect(parseWalletAuthSubject(subject)).toBeNull();
  });
});
