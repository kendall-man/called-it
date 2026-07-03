import { describe, expect, it } from 'vitest';
import {
  assertSafeLamports,
  formatSol,
  formatSolAmount,
  parseSolToLamports,
  shortPubkey,
} from './format.js';

describe('formatSol', () => {
  const vectors: Array<[bigint, string]> = [
    [0n, '0'],
    [1n, '0.000000001'],
    [123n, '0.000000123'],
    [10_000_000n, '0.01'],
    [50_000_000n, '0.05'],
    [100_000_000n, '0.1'],
    [1_000_000_000n, '1'],
    [1_500_000_000n, '1.5'],
    [2_500_000_001n, '2.500000001'],
    [-10_000_000n, '-0.01'],
  ];

  it.each(vectors)('%s lamports → %s', (lamports, expected) => {
    expect(formatSol(lamports)).toBe(expected);
  });

  it('formatSolAmount appends the unit', () => {
    expect(formatSolAmount(10_000_000n)).toBe('0.01 SOL');
  });
});

describe('parseSolToLamports', () => {
  const good: Array<[string, bigint]> = [
    ['0.01', 10_000_000n],
    ['1', 1_000_000_000n],
    ['1.5', 1_500_000_000n],
    ['0.000000001', 1n],
    [' 0.05 ', 50_000_000n],
    ['0', 0n],
  ];

  it.each(good)('parses %s', (text, expected) => {
    expect(parseSolToLamports(text)).toBe(expected);
  });

  const bad = ['', 'all', '-1', '1.', '.5', '0.0000000001', '1,5', '1e9', '0x10', 'SOL'];

  it.each(bad)('rejects %s', (text) => {
    expect(parseSolToLamports(text)).toBeNull();
  });

  it('round-trips with formatSol', () => {
    for (const lamports of [1n, 10_000_000n, 1_500_000_000n, 2_500_000_001n]) {
      expect(parseSolToLamports(formatSol(lamports))).toBe(lamports);
    }
  });
});

describe('assertSafeLamports', () => {
  it('converts safe integers', () => {
    expect(assertSafeLamports(10_000_000, 'test')).toBe(10_000_000n);
  });

  it('fails loud past 2^53 — silent corruption is forbidden', () => {
    expect(() => assertSafeLamports(2 ** 53, 'test')).toThrow(/safe integer/);
    expect(() => assertSafeLamports(1.5, 'test')).toThrow(/safe integer/);
  });
});

describe('shortPubkey', () => {
  it('keeps both ends of a long address', () => {
    expect(shortPubkey('AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcd')).toBe('AbCd…abcd');
  });

  it('leaves short strings alone', () => {
    expect(shortPubkey('short')).toBe('short');
  });
});
