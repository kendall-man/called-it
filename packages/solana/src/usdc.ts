import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  PublicKey,
  Transaction,
  type Connection,
  type Keypair,
} from '@solana/web3.js';
import { base58Encode } from './codecs.js';

export type SupportedSolanaNetwork = 'devnet' | 'mainnet-beta';

export const USDC_MINTS: Readonly<Record<SupportedSolanaNetwork, string>> = {
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

export const USDC_DECIMALS = 6;
const U64_MAX = (1n << 64n) - 1n;

export function usdcMintAddress(network: SupportedSolanaNetwork): PublicKey {
  return new PublicKey(USDC_MINTS[network]);
}

export function usdcAssociatedTokenAddress(
  owner: PublicKey | string,
  network: SupportedSolanaNetwork,
): PublicKey {
  const ownerKey = typeof owner === 'string' ? new PublicKey(owner) : owner;
  return getAssociatedTokenAddressSync(
    usdcMintAddress(network),
    ownerKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

export async function getUsdcBalance(
  connection: Connection,
  owner: PublicKey | string,
  network: SupportedSolanaNetwork,
): Promise<bigint> {
  const tokenAccount = usdcAssociatedTokenAddress(owner, network);
  const account = await connection.getAccountInfo(tokenAccount, 'confirmed');
  if (account === null) return 0n;
  const response = await connection.getTokenAccountBalance(tokenAccount, 'confirmed');
  if (response.value.decimals !== USDC_DECIMALS || !/^\d+$/.test(response.value.amount)) {
    throw new Error('getUsdcBalance: unexpected USDC token account response');
  }
  return BigInt(response.value.amount);
}

export interface BuildUsdcTransferParams {
  from: Keypair;
  to: PublicKey | string;
  amountAtomic: bigint;
  network: SupportedSolanaNetwork;
  recentBlockhash: string;
  lastValidBlockHeight: number;
}

export type BuildUsdcTransferResult =
  | { ok: true; rawTxB64: string; sig: string }
  | { ok: false; error: string };

export function buildUsdcTransfer(params: BuildUsdcTransferParams): BuildUsdcTransferResult {
  const { from, amountAtomic, network, recentBlockhash, lastValidBlockHeight } = params;
  if (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n || amountAtomic > U64_MAX) {
    return {
      ok: false,
      error: `buildUsdcTransfer: amountAtomic must be a positive u64 bigint, got ${String(amountAtomic)}`,
    };
  }
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
    return {
      ok: false,
      error: 'buildUsdcTransfer: lastValidBlockHeight must be a positive integer',
    };
  }
  try {
    const destinationOwner = typeof params.to === 'string' ? new PublicKey(params.to) : params.to;
    const mint = usdcMintAddress(network);
    const source = usdcAssociatedTokenAddress(from.publicKey, network);
    const destination = usdcAssociatedTokenAddress(destinationOwner, network);
    const tx = new Transaction({
      feePayer: from.publicKey,
      blockhash: recentBlockhash,
      lastValidBlockHeight,
    });
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        from.publicKey,
        destination,
        destinationOwner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createTransferCheckedInstruction(
        source,
        mint,
        destination,
        from.publicKey,
        amountAtomic,
        USDC_DECIMALS,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );
    tx.sign(from);
    const signature = tx.signature;
    if (signature === null) return { ok: false, error: 'buildUsdcTransfer: signing produced no signature' };
    return {
      ok: true,
      rawTxB64: tx.serialize().toString('base64'),
      sig: base58Encode(signature),
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `buildUsdcTransfer: ${message}` };
  }
}
