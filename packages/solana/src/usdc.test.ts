import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
} from '@solana/spl-token';
import { Keypair, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  buildUsdcTransfer,
  getUsdcBalance,
  USDC_DECIMALS,
  USDC_MINTS,
  usdcAssociatedTokenAddress,
  usdcMintAddress,
} from './usdc.js';

describe('USDC network configuration', () => {
  it('uses the official Circle mint for each network and distinct ATAs', () => {
    expect(usdcMintAddress('mainnet-beta').toBase58()).toBe(USDC_MINTS['mainnet-beta']);
    expect(usdcMintAddress('devnet').toBase58()).toBe(USDC_MINTS.devnet);
    const owner = Keypair.generate().publicKey;
    expect(usdcAssociatedTokenAddress(owner, 'mainnet-beta').equals(
      usdcAssociatedTokenAddress(owner, 'devnet'),
    )).toBe(false);
  });

  it('returns zero for a missing ATA and validates the mint decimal scale', async () => {
    const owner = Keypair.generate().publicKey;
    const missing = {
      getAccountInfo: async () => null,
      getTokenAccountBalance: async () => { throw new Error('must not read a missing account'); },
    };
    await expect(getUsdcBalance(missing as never, owner, 'devnet')).resolves.toBe(0n);

    const existing = {
      getAccountInfo: async () => ({ data: new Uint8Array() }),
      getTokenAccountBalance: async () => ({
        value: { amount: '1234567', decimals: USDC_DECIMALS },
      }),
    };
    await expect(getUsdcBalance(existing as never, owner, 'devnet')).resolves.toBe(1_234_567n);
  });
});

describe('buildUsdcTransfer', () => {
  it('creates the destination ATA idempotently and transfers checked atomic units', () => {
    const from = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const result = buildUsdcTransfer({
      from,
      to,
      amountAtomic: 5_000_001n,
      network: 'mainnet-beta',
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 123,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const transaction = Transaction.from(Buffer.from(result.rawTxB64, 'base64'));
    expect(transaction.verifySignatures()).toBe(true);
    expect(transaction.instructions[0]?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    const transfer = decodeTransferCheckedInstruction(transaction.instructions[1]!, TOKEN_PROGRAM_ID);
    expect(transfer.data.amount).toBe(5_000_001n);
    expect(transfer.data.decimals).toBe(USDC_DECIMALS);
    expect(transfer.keys.owner.pubkey.equals(from.publicKey)).toBe(true);
    expect(transfer.keys.mint.pubkey.equals(usdcMintAddress('mainnet-beta'))).toBe(true);
    expect(transfer.keys.destination.pubkey.equals(
      usdcAssociatedTokenAddress(to, 'mainnet-beta'),
    )).toBe(true);
  });

  it('rejects zero and values outside the SPL u64 range before signing', () => {
    const base = {
      from: Keypair.generate(),
      to: Keypair.generate().publicKey,
      network: 'devnet' as const,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 123,
    };
    expect(buildUsdcTransfer({ ...base, amountAtomic: 0n }).ok).toBe(false);
    expect(buildUsdcTransfer({ ...base, amountAtomic: 1n << 64n }).ok).toBe(false);
  });
});
