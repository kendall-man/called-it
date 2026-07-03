import { Keypair } from '@solana/web3.js';
import { base58Decode } from './codecs.js';

const SECRET_KEY_LEN = 64; // ed25519 seed (32) + public key (32)
const SEED_LEN = 32;

/**
 * Load the server hot wallet from a base58-encoded secret key
 * (`SOLANA_KEYPAIR_B58`). Accepts either the full 64-byte secret key
 * (Phantom/solana-keygen export) or a raw 32-byte seed.
 */
export function loadWallet(secretKeyB58: string): Keypair {
  const trimmed = secretKeyB58.trim();
  if (trimmed.length === 0) {
    throw new Error('loadWallet: empty secret key — set SOLANA_KEYPAIR_B58');
  }
  let decoded: Uint8Array;
  try {
    decoded = base58Decode(trimmed);
  } catch (cause) {
    throw new Error(
      'loadWallet: secret key is not valid base58 — expected the base58 string of a 64-byte Solana secret key',
      { cause },
    );
  }
  if (decoded.length === SECRET_KEY_LEN) return Keypair.fromSecretKey(decoded);
  if (decoded.length === SEED_LEN) return Keypair.fromSeed(decoded);
  throw new Error(
    `loadWallet: decoded key is ${decoded.length} bytes — expected ${SECRET_KEY_LEN} (full secret key) or ${SEED_LEN} (seed)`,
  );
}
