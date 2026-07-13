import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

export const MIN_WALLET_TRANSFER_LAMPORTS = 1_000_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

export function parseSolAmount(value: string): bigint | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  const lamports = BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(9, '0'));
  return lamports > 0n && lamports <= BigInt(Number.MAX_SAFE_INTEGER) ? lamports : null;
}

export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

export async function walletBalance(rpcUrl: string, wallet: PublicKey): Promise<bigint> {
  const connection = new Connection(resolveRpcUrl(rpcUrl), 'confirmed');
  return BigInt(await connection.getBalance(wallet, 'confirmed'));
}

export async function sendWalletTransfer(input: {
  readonly rpcUrl: string;
  readonly keypair: Keypair;
  readonly destination: string;
  readonly lamports: bigint;
}): Promise<string> {
  if (input.lamports < MIN_WALLET_TRANSFER_LAMPORTS) {
    throw new Error('Transfers must be at least 0.001 SOL.');
  }
  let destination: PublicKey;
  try {
    destination = new PublicKey(input.destination);
  } catch {
    throw new Error('Destination address is not valid.');
  }
  if (destination.equals(input.keypair.publicKey)) {
    throw new Error('Choose a different destination address.');
  }
  const connection = new Connection(resolveRpcUrl(input.rpcUrl), 'confirmed');
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: input.keypair.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(SystemProgram.transfer({
    fromPubkey: input.keypair.publicKey,
    toPubkey: destination,
    lamports: Number(input.lamports),
  }));
  transaction.sign(input.keypair);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (status.value?.err !== null && status.value?.err !== undefined) {
      throw new Error('The transfer was rejected by Solana.');
    }
    if (
      status.value?.confirmationStatus === 'confirmed' ||
      status.value?.confirmationStatus === 'finalized'
    ) {
      return signature;
    }
    await delay(1_000);
  }
  return signature;
}

export function explorerTransactionUrl(signature: string, network: 'devnet' | 'mainnet-beta'): string {
  const url = new URL(`/tx/${signature}`, 'https://explorer.solana.com');
  if (network === 'devnet') url.searchParams.set('cluster', 'devnet');
  return url.toString();
}

function resolveRpcUrl(value: string): string {
  if (/^https?:\/\//.test(value)) return value;
  if (typeof window === 'undefined') throw new Error('Wallet RPC is unavailable.');
  return new URL(value, window.location.origin).toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
