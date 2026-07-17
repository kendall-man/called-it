import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { Keypair, PublicKey } from '@solana/web3.js';
import { fail } from './errors.js';

export async function loadOwnerKeypair(path: string, expectedOwner: PublicKey): Promise<Keypair> {
  if (path.trim().length === 0) fail('credential_invalid', 'keypair file path is required');
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    fail('credential_invalid', 'keypair path must reference a regular non-symlink file');
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    fail('credential_permissions', 'keypair file must have mode 0600');
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    fail('credential_permissions', 'keypair file must be owned by the current user');
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (handle === null) fail('credential_invalid', 'keypair file could not be opened securely');
  let raw: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.ino !== metadata.ino || opened.dev !== metadata.dev) {
      fail('credential_permissions', 'keypair file changed during secure open');
    }
    raw = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    fail('credential_invalid', 'keypair file must contain a Solana JSON keypair');
  }
  if (!Array.isArray(value) || value.length !== 64 || value.some(
    (byte) => !Number.isInteger(byte) || byte < 0 || byte > 255,
  )) {
    fail('credential_invalid', 'keypair file must contain exactly 64 byte values');
  }
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(value as number[]));
  } catch {
    fail('credential_invalid', 'keypair file is not a valid Solana keypair');
  }
  if (!keypair.publicKey.equals(expectedOwner)) {
    fail('identity_mismatch', 'keypair public key does not match the requested owner');
  }
  return keypair;
}
