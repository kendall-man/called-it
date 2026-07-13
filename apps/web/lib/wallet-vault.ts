import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export const WALLET_VAULT_STORAGE_KEY = 'called-it:wallet:v1';
const PBKDF2_ITERATIONS = 250_000;
const MIN_PASSCODE_LENGTH = 8;

export interface EncryptedWalletVault {
  readonly version: 1;
  readonly pubkey: string;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

export interface CreatedWallet {
  readonly vault: EncryptedWalletVault;
  readonly keypair: Keypair;
  readonly recoveryKey: string;
}

export async function createEncryptedWallet(passcode: string): Promise<CreatedWallet> {
  validatePasscode(passcode);
  return encryptKeypair(Keypair.generate(), passcode);
}

export async function recoverEncryptedWallet(
  recoveryKey: string,
  passcode: string,
): Promise<CreatedWallet> {
  validatePasscode(passcode);
  let secret: Uint8Array;
  try {
    secret = bs58.decode(recoveryKey.trim());
  } catch {
    throw new Error('Recovery key is not valid.');
  }
  if (secret.length !== 64) throw new Error('Recovery key is not valid.');
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(secret);
  } catch {
    throw new Error('Recovery key is not valid.');
  }
  return encryptKeypair(keypair, passcode);
}

export async function unlockEncryptedWallet(
  vault: EncryptedWalletVault,
  passcode: string,
): Promise<Keypair> {
  validateVault(vault);
  try {
    const key = await deriveKey(passcode, fromBase64(vault.salt));
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(fromBase64(vault.iv)),
        additionalData: arrayBuffer(vaultAad(vault.pubkey)),
      },
      key,
      arrayBuffer(fromBase64(vault.ciphertext)),
    );
    const keypair = Keypair.fromSecretKey(new Uint8Array(decrypted));
    if (keypair.publicKey.toBase58() !== vault.pubkey) throw new Error('wallet mismatch');
    return keypair;
  } catch {
    throw new Error('Passcode is incorrect or this wallet backup is damaged.');
  }
}

export function recoveryKeyFor(keypair: Keypair): string {
  return bs58.encode(keypair.secretKey);
}

export function parseStoredVault(raw: string | null): EncryptedWalletVault | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    validateVault(parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function encryptKeypair(keypair: Keypair, passcode: string): Promise<CreatedWallet> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pubkey = keypair.publicKey.toBase58();
  const key = await deriveKey(passcode, salt);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: arrayBuffer(iv),
      additionalData: arrayBuffer(vaultAad(pubkey)),
    },
    key,
    arrayBuffer(keypair.secretKey),
  );
  return {
    keypair,
    recoveryKey: recoveryKeyFor(keypair),
    vault: {
      version: 1,
      pubkey,
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
    },
  };
}

async function deriveKey(passcode: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    arrayBuffer(new TextEncoder().encode(passcode)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: arrayBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function validatePasscode(passcode: string): void {
  if (passcode.length < MIN_PASSCODE_LENGTH) {
    throw new Error(`Use a passcode with at least ${MIN_PASSCODE_LENGTH} characters.`);
  }
}

function validateVault(value: unknown): asserts value is EncryptedWalletVault {
  if (
    typeof value !== 'object' || value === null ||
    !('version' in value) || value.version !== 1 ||
    !('pubkey' in value) || typeof value.pubkey !== 'string' ||
    !('salt' in value) || typeof value.salt !== 'string' ||
    !('iv' in value) || typeof value.iv !== 'string' ||
    !('ciphertext' in value) || typeof value.ciphertext !== 'string'
  ) {
    throw new Error('Wallet backup is damaged.');
  }
}

function vaultAad(pubkey: string): Uint8Array {
  return new TextEncoder().encode(`called-it-wallet-v1:${pubkey}`);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
