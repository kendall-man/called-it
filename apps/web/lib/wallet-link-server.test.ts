import { describe, expect, it } from 'vitest';
import { walletChallengeNonce, walletSessionTokenHash } from './wallet-link-server';

describe('wallet link server secrets', () => {
  it('stores a fixed hash and derives challenge-specific nonces', () => {
    const token = 'A'.repeat(43);
    const first = walletChallengeNonce(token, '00000000-0000-4000-8000-000000000001');
    const second = walletChallengeNonce(token, '00000000-0000-4000-8000-000000000002');
    expect(walletSessionTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(token);
  });
});
