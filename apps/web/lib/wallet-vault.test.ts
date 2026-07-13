import { describe, expect, it } from 'vitest';
import {
  createEncryptedWallet,
  parseStoredVault,
  recoverEncryptedWallet,
  recoveryKeyFor,
  unlockEncryptedWallet,
} from './wallet-vault';

describe('encrypted self-custody wallet vault', () => {
  it('encrypts, unlocks, and recovers the same Solana keypair', async () => {
    const created = await createEncryptedWallet('correct horse battery');
    const unlocked = await unlockEncryptedWallet(created.vault, 'correct horse battery');
    const recovered = await recoverEncryptedWallet(created.recoveryKey, 'another strong passcode');

    expect(unlocked.publicKey.toBase58()).toBe(created.vault.pubkey);
    expect(recoveryKeyFor(unlocked)).toBe(created.recoveryKey);
    expect(recovered.vault.pubkey).toBe(created.vault.pubkey);
  });

  it('refuses a wrong passcode and malformed stored data', async () => {
    const created = await createEncryptedWallet('correct horse battery');
    await expect(unlockEncryptedWallet(created.vault, 'totally wrong passcode')).rejects.toThrow(
      'Passcode is incorrect',
    );
    expect(parseStoredVault('{"version":2}')).toBeNull();
  });
});
