import { describe, expect, it } from 'vitest';
import { formatMultiplier, formatProbabilityPct, formatRep, formatUtc } from './format';

describe('formatMultiplier', () => {
  it('renders whole multipliers without decimals', () => {
    expect(formatMultiplier(9)).toBe('×9');
    expect(formatMultiplier(9.02)).toBe('×9');
  });

  it('keeps one decimal otherwise, never odds notation', () => {
    expect(formatMultiplier(2.45)).toBe('×2.5');
    expect(formatMultiplier(1.02)).toBe('×1');
    expect(formatMultiplier(11.5)).not.toMatch(/\d\/\d/);
  });
});

describe('formatProbabilityPct', () => {
  it('rounds to whole percent', () => {
    expect(formatProbabilityPct(0.09)).toBe('9%');
    expect(formatProbabilityPct(0.421)).toBe('42%');
  });

  it('floors tiny probabilities at <1% and clamps out-of-range input', () => {
    expect(formatProbabilityPct(0.001)).toBe('<1%');
    expect(formatProbabilityPct(0)).toBe('0%');
    expect(formatProbabilityPct(1.7)).toBe('100%');
    expect(formatProbabilityPct(-0.2)).toBe('0%');
  });
});

describe('formatRep', () => {
  it('adds thousands separators and no currency symbol', () => {
    expect(formatRep(1250)).toBe('1,250');
    expect(formatRep(1250)).not.toMatch(/[$£€]/);
  });
});

describe('formatUtc', () => {
  it('renders a stable UTC stamp', () => {
    expect(formatUtc('2026-07-10T18:05:00.000Z')).toBe('10 Jul, 18:05 UTC');
  });

  it('returns empty for garbage input instead of throwing', () => {
    expect(formatUtc('not-a-date')).toBe('');
  });
});
