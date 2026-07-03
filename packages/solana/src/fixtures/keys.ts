/**
 * Deterministic, INVENTED identities for hermetic chain-I/O tests.
 * Everything is derived offline from fixed seeds — no real chain data ever
 * enters the repo, and reruns always produce the same base58 strings.
 */
import { Keypair } from '@solana/web3.js';
import { base58Encode } from '../codecs.js';

const SEED_LEN = 32;
const SIGNATURE_LEN = 64;

function seededKeypair(seedByte: number): Keypair {
  return Keypair.fromSeed(new Uint8Array(SEED_LEN).fill(seedByte));
}

export const TREASURY_KEYPAIR = seededKeypair(7);
export const TREASURY = TREASURY_KEYPAIR.publicKey.toBase58();
export const ALICE = seededKeypair(11).publicKey.toBase58();
export const BOB = seededKeypair(13).publicKey.toBase58();
export const MALLORY = seededKeypair(17).publicKey.toBase58();

/** Well-formed (64-byte base58) but invented transaction signature. */
export function fakeSig(label: number): string {
  const bytes = new Uint8Array(SIGNATURE_LEN);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (label * 31 + i * 7 + 5) % 256;
  }
  return base58Encode(bytes);
}
