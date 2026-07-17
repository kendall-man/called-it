import { describe, expect, it } from 'vitest';
import { walletSessionTokenFromLocation } from './wallet-session';

const TOKEN = 'A'.repeat(43);

describe('walletSessionTokenFromLocation', () => {
  it('reads a session token from the path without occupying Telegram auth parameters', () => {
    expect(walletSessionTokenFromLocation({
      pathname: `/wallet/${TOKEN}`,
      search: '',
    })).toBe(TOKEN);
  });

  it('accepts query links issued during the rollout', () => {
    expect(walletSessionTokenFromLocation({
      pathname: '/wallet',
      search: `?token=${TOKEN}`,
    })).toBe(TOKEN);
  });

  it('rejects missing and malformed session tokens', () => {
    expect(walletSessionTokenFromLocation({ pathname: '/wallet', search: '' })).toBeNull();
    expect(walletSessionTokenFromLocation({ pathname: '/wallet/short', search: '' })).toBeNull();
  });
});
