import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  deriveMarketPda,
  deriveOracleSetPda,
  derivePositionLotPda,
  deriveProtocolConfigPda,
  deriveSolVaultPda,
  deriveUserPositionPda,
  deriveUsdcVaultAddress,
} from '../src/addresses.js';

const PROGRAM = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const OWNER = new PublicKey('Vote111111111111111111111111111111111111111');
const MINT = new PublicKey('So11111111111111111111111111111111111111112');
const UUID = '00112233-4455-6677-8899-aabbccddeeff';

describe('escrow PDA derivation', () => {
  it('derives stable, distinct protocol addresses', () => {
    const config = deriveProtocolConfigPda(PROGRAM);
    const oracle = deriveOracleSetPda(PROGRAM, 7n);
    const market = deriveMarketPda(PROGRAM, UUID);
    const position = deriveUserPositionPda(PROGRAM, market.publicKey, OWNER);
    const lot = derivePositionLotPda(PROGRAM, market.publicKey, OWNER, 3n);
    const vault = deriveSolVaultPda(PROGRAM, market.publicKey);

    expect(new Set([config, oracle, market, position, lot, vault].map((pda) => pda.address)).size)
      .toBe(6);
    expect(deriveMarketPda(PROGRAM, UUID)).toEqual(market);
    expect(derivePositionLotPda(PROGRAM, market.publicKey, OWNER, 4n).address)
      .not.toBe(lot.address);
  });

  it('derives the canonical classic SPL associated token vault', () => {
    const market = deriveMarketPda(PROGRAM, UUID);
    const vault = deriveUsdcVaultAddress(market.publicKey, MINT);
    expect(vault.toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(deriveUsdcVaultAddress(market.publicKey, MINT).equals(vault)).toBe(true);
  });

  it('rejects malformed UUIDs and integers outside u64', () => {
    expect(() => deriveMarketPda(PROGRAM, 'not-a-uuid')).toThrow(/UUID/);
    expect(() => deriveOracleSetPda(PROGRAM, -1n)).toThrow(/u64/);
    expect(() => derivePositionLotPda(PROGRAM, OWNER, OWNER, 1n << 64n)).toThrow(/u64/);
  });
});
