import { describe, expect, it } from 'vitest';
import { formatSol, parseSolAmount } from './wallet-transfers';

describe('wallet transfer amount parsing', () => {
  it('uses exact decimal lamports without floating point rounding', () => {
    expect(parseSolAmount('0.001')).toBe(1_000_000n);
    expect(parseSolAmount('0.01')).toBe(10_000_000n);
    expect(parseSolAmount('1.000000001')).toBe(1_000_000_001n);
    expect(formatSol(1_000_000_001n)).toBe('1.000000001');
  });

  it('rejects zero, negative, malformed, and over-precise amounts', () => {
    expect(parseSolAmount('0')).toBeNull();
    expect(parseSolAmount('-1')).toBeNull();
    expect(parseSolAmount('0.0000000001')).toBeNull();
    expect(parseSolAmount('1e-3')).toBeNull();
  });
});
