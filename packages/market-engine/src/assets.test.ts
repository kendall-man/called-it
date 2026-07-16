import { describe, expect, it } from 'vitest';
import {
  formatAtomicAmount,
  formatWagerAmount,
  isWagerAsset,
  parseAtomicAmount,
  WAGER_ASSET_DEFINITIONS,
} from './assets.js';

describe('wager assets', () => {
  it('uses the native decimal scale for SOL and Circle USDC', () => {
    expect(WAGER_ASSET_DEFINITIONS.sol.atomicUnitsPerToken).toBe(1_000_000_000n);
    expect(WAGER_ASSET_DEFINITIONS.usdc.atomicUnitsPerToken).toBe(1_000_000n);
    expect(formatAtomicAmount(1_500_001n, 'usdc')).toBe('1.500001');
    expect(formatWagerAmount(10_000_000n, 'sol')).toBe('0.01 SOL');
  });

  it('parses exact decimal amounts without floating point arithmetic', () => {
    expect(parseAtomicAmount('0', 'usdc')).toBe(0n);
    expect(parseAtomicAmount('1', 'usdc')).toBe(1_000_000n);
    expect(parseAtomicAmount('1.000001', 'usdc')).toBe(1_000_001n);
    expect(parseAtomicAmount('0.000000001', 'sol')).toBe(1n);
  });

  it('rejects malformed and over-precise amounts', () => {
    expect(parseAtomicAmount('0.0000001', 'usdc')).toBeNull();
    expect(parseAtomicAmount('-1', 'usdc')).toBeNull();
    expect(parseAtomicAmount('1e3', 'usdc')).toBeNull();
    expect(isWagerAsset('rep')).toBe(false);
    expect(isWagerAsset('usdc')).toBe(true);
  });
});
