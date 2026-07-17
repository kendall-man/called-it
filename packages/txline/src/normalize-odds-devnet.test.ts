import { describe, expect, it, vi } from 'vitest';
import {
  combineOddsSnapshot,
  isFullMatchPeriod,
  normalizeOdds,
  parseTotalsLine,
} from './normalize-odds.js';
import { silentLogger } from './logging.js';
import { FIXTURE_ID } from './test-fixtures.js';

const normalize = (payload: unknown) => normalizeOdds(payload, { logger: silentLogger });

describe('devnet wire shapes (empirical 2026-07-03, synthetic values)', () => {
  const wire1x2 = (overrides: Record<string, unknown> = {}) => ({
    FixtureId: FIXTURE_ID,
    MessageId: 'wire-1x2-a',
    Ts: 1_000,
    Bookmaker: 'TXLineStablePriceDemargined',
    BookmakerId: 10021,
    SuperOddsType: '1X2_PARTICIPANT_RESULT',
    GameState: null,
    InRunning: false,
    MarketParameters: null,
    MarketPeriod: null,
    PriceNames: ['part1', 'draw', 'part2'],
    Prices: [2000, 3000, 4000],
    Pct: ['50.000', '30.000', '20.000'],
    ...overrides,
  });
  const wireTotals = (overrides: Record<string, unknown> = {}) => ({
    ...wire1x2({
      MessageId: 'wire-ou-a',
      SuperOddsType: 'OVERUNDER_PARTICIPANT_GOALS',
      MarketParameters: 'line=2.5',
      PriceNames: ['over', 'under'],
      Prices: [1800, 2100],
      Pct: ['56.000', '44.000'],
    }),
    ...overrides,
  });

  it('classifies 1X2_PARTICIPANT_RESULT and maps part1→home, part2→away', () => {
    const inputs = normalize(wire1x2());
    expect(inputs?.p1x2?.home).toBeCloseTo(0.5, 6);
    expect(inputs?.p1x2?.draw).toBeCloseTo(0.3, 6);
    expect(inputs?.p1x2?.away).toBeCloseTo(0.2, 6);
  });

  it('maps part1/part2 by name even when shuffled', () => {
    const inputs = normalize(
      wire1x2({ PriceNames: ['draw', 'part2', 'part1'], Pct: ['30.000', '20.000', '50.000'] }),
    );
    expect(inputs?.p1x2?.home).toBeCloseTo(0.5, 6);
    expect(inputs?.p1x2?.away).toBeCloseTo(0.2, 6);
  });

  it('rejects the key=value first-half period "half=1"', () => {
    expect(normalize(wire1x2({ MarketPeriod: 'half=1' }))).toBeNull();
    expect(normalize(wireTotals({ MarketPeriod: 'half=1' }))).toBeNull();
    expect(isFullMatchPeriod('half=1', silentLogger)).toBe(false);
    expect(isFullMatchPeriod('half=2', silentLogger)).toBe(false);
    expect(isFullMatchPeriod(null, silentLogger)).toBe(true);
  });

  it('rejects extra-time and penalty periods (observed live: "et", "penalties")', () => {
    expect(normalize(wire1x2({ MarketPeriod: 'et' }))).toBeNull();
    expect(isFullMatchPeriod('et', silentLogger)).toBe(false);
    expect(isFullMatchPeriod('ET1', silentLogger)).toBe(false);
    expect(isFullMatchPeriod('AET', silentLogger)).toBe(false);
    expect(isFullMatchPeriod('penalties', silentLogger)).toBe(false);
    expect(isFullMatchPeriod('PEN', silentLogger)).toBe(false);
  });

  it('parses the "line=X" MarketParameters grammar', () => {
    const inputs = normalize(wireTotals());
    expect(inputs?.totals?.line).toBe(2.5);
    expect(inputs?.totals?.overProb).toBeCloseTo(0.56, 6);
    expect(parseTotalsLine('line=1')).toBe(1);
    expect(parseTotalsLine('line=-1')).toBe(-1);
    expect(parseTotalsLine(null)).toBeNull();
  });

  it('skips ASIANHANDICAP_PARTICIPANT_GOALS silently (known-unpriced, no log spam)', () => {
    const logger = vi.fn();
    const inputs = normalizeOdds(
      wire1x2({
        SuperOddsType: 'ASIANHANDICAP_PARTICIPANT_GOALS',
        MarketParameters: 'line=-1',
        PriceNames: ['part1', 'part2'],
        Prices: [1900, 2000],
        Pct: ['51.000', '49.000'],
      }),
      { logger },
    );
    expect(inputs).toBeNull();
    expect(logger).not.toHaveBeenCalledWith('unknown SuperOddsType', expect.anything());
  });

  it('quarter lines with NA percentages are skipped', () => {
    expect(
      normalize(wireTotals({ MarketParameters: 'line=2.25', Pct: ['NA', 'NA'] })),
    ).toBeNull();
  });

  it('combineOddsSnapshot prefers half-goal lines over a closer-to-even integer line', () => {
    const inputs = combineOddsSnapshot(
      [
        wireTotals({ MessageId: 'wire-int', MarketParameters: 'line=3', Pct: ['50.000', '50.000'] }),
        wireTotals({ MessageId: 'wire-half', MarketParameters: 'line=2.5', Pct: ['56.000', '44.000'] }),
      ],
      { logger: silentLogger },
    );
    expect(inputs?.totals?.line).toBe(2.5);
    expect(inputs?.oddsMessageId).toBe('wire-half');
  });

  it('combineOddsSnapshot falls back to an integer line when no half line is usable', () => {
    const inputs = combineOddsSnapshot(
      [wireTotals({ MessageId: 'wire-int', MarketParameters: 'line=1', Pct: ['62.000', '38.000'] })],
      { logger: silentLogger },
    );
    expect(inputs?.totals?.line).toBe(1);
  });

  it('a full devnet-shaped snapshot combines to full-match 1X2 + half-line totals', () => {
    const inputs = combineOddsSnapshot(
      [
        wire1x2({ MessageId: 'w-1x2-half', MarketPeriod: 'half=1', Ts: 5_000 }),
        wire1x2({ MessageId: 'w-1x2-full', Ts: 1_000 }),
        wireTotals({ MessageId: 'w-ou-half', MarketPeriod: 'half=1', MarketParameters: 'line=1' }),
        wireTotals({ MessageId: 'w-ou-full', MarketParameters: 'line=2.5' }),
      ],
      { logger: silentLogger },
    );
    expect(inputs?.oddsMessageId).toBe('w-1x2-full');
    expect(inputs?.p1x2?.home).toBeCloseTo(0.5, 6);
    expect(inputs?.totals?.line).toBe(2.5);
  });
});
