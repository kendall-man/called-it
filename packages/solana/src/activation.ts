import { createPrivateKey, sign as ed25519Sign } from 'node:crypto';
import type { Keypair } from '@solana/web3.js';

/**
 * DER prefix that wraps a raw ed25519 seed into a PKCS#8 private key, so the
 * built-in node:crypto signer can be used instead of adding tweetnacl.
 * (RFC 8410: SEQUENCE { version 0, OID 1.3.101.112, OCTET STRING(seed) }.)
 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SEED_LEN = 32;

/** The exact message TxLINE expects the wallet to sign for /api/token/activate. */
export function activationMessage(
  txSig: string,
  leagues: readonly number[],
  jwt: string,
): string {
  return `${txSig}:${leagues.join(',')}:${jwt}`;
}

/**
 * ed25519 detached signature over `${txSig}:${leagues.join(',')}:${jwt}`,
 * base64-encoded — the `walletSignature` field of POST /api/token/activate.
 * For an empty leagues array the signed message is `${txSig}::${jwt}`.
 */
export function signActivation(
  wallet: Keypair,
  txSig: string,
  leagues: readonly number[],
  jwt: string,
): string {
  const seed = Buffer.from(wallet.secretKey.subarray(0, ED25519_SEED_LEN));
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const message = Buffer.from(activationMessage(txSig, leagues, jwt), 'utf8');
  // ed25519 hashes internally; algorithm must be null.
  return ed25519Sign(null, message, privateKey).toString('base64');
}
