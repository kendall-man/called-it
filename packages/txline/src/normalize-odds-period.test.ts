import { describe, expect, it, vi } from 'vitest';
import { isFullMatchPeriod, normalizeMarketPeriod, normalizeOdds } from './normalize-odds.js';
import { silentLogger } from './logging.js';
import { oddsRecord } from './test-fixtures.js';

const normalize = (payload: unknown) => normalizeOdds(payload, { logger: silentLogger });

const REJECTED_MARKET_PERIODS = [
  '1H',
  '2H',
  'HT',
  'AET',
  'ET',
  'OT',
  'PEN',
  'et,half=1',
  'period=FT',
  'FT;1H',
  'FULLTIME_EXTRA',
  'XFT',
  'FT/OT',
] as const;

function seededMalformedPeriods(count: number): string[] {
  let state = 0x5eed1234;
  return Array.from({ length: count }, (_, index) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return `seed_${state.toString(36)}:${index}`;
  });
}

describe('normalizeOdds — filtering and defensiveness', () => {
  it('rejects half-time markets', () => {
    expect(normalize(oddsRecord({ MarketPeriod: '1H' }))).toBeNull();
    expect(normalize(oddsRecord({ MarketPeriod: 'HT' }))).toBeNull();
  });

  it('rejects a key-value period even when it contains an allowed token', () => {
    const inputs = normalize(oddsRecord({ MarketPeriod: 'period=FT' }));

    expect(inputs).toBeNull();
  });

  it('logs a bounded fingerprint instead of the observed malformed period', () => {
    const marketPeriod = 'et,half=1';
    const logger = vi.fn();

    const inputs = normalizeOdds(oddsRecord({ MarketPeriod: marketPeriod }), { logger });

    expect(inputs).toBeNull();
    expect(logger).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith('odds period rejected', {
      reason: 'unsupported_period',
      periodHash: '0d411720919f',
      periodLength: 9,
    });
    expect(JSON.stringify(logger.mock.calls)).not.toContain(marketPeriod);
  });

  it('caps the reported length for an oversized malformed period', () => {
    const logger = vi.fn();

    normalizeOdds(oddsRecord({ MarketPeriod: 'x'.repeat(1_000) }), { logger });

    expect(logger).toHaveBeenCalledWith(
      'odds period rejected',
      expect.objectContaining({ reason: 'unsupported_period', periodLength: 128 }),
    );
  });
});

describe('helpers', () => {
  it.each([
    null,
    undefined,
    '',
    '   ',
    'M',
    'm',
    'FT',
    ' ft ',
    'MATCH',
    'FULL',
    'FULLTIME',
    '90',
    'REG',
    'REGULAR',
    ' REGULAR ',
  ])('emits odds for the full-match period alias %j', (marketPeriod) => {
    const inputs = normalize(oddsRecord({ MarketPeriod: marketPeriod }));

    expect(inputs?.p1x2).not.toBeNull();
  });

  it.each(REJECTED_MARKET_PERIODS)(
    'returns unsupported_period for the non-full-match value %j',
    (marketPeriod) => {
      const result = normalizeMarketPeriod(marketPeriod);

      expect(result).toEqual({ kind: 'rejected', reason: 'unsupported_period' });
    },
  );

  it.each(REJECTED_MARKET_PERIODS)('emits no odds for the non-full-match value %j', (marketPeriod) => {
    const inputs = normalize(oddsRecord({ MarketPeriod: marketPeriod }));

    expect(inputs).toBeNull();
  });

  it('rejects 100 deterministic seeded malformed values without logging any raw value', () => {
    const marketPeriods = seededMalformedPeriods(100);
    const logger = vi.fn();

    const results = marketPeriods.map((marketPeriod) => ({
      period: normalizeMarketPeriod(marketPeriod),
      odds: normalizeOdds(oddsRecord({ MarketPeriod: marketPeriod }), { logger }),
    }));

    expect(results).toHaveLength(100);
    expect(results.every(({ period }) => period.kind === 'rejected' && period.reason === 'unsupported_period')).toBe(
      true,
    );
    expect(results.every(({ odds }) => odds === null)).toBe(true);
    expect(logger).toHaveBeenCalledTimes(100);
    const renderedLogs = JSON.stringify(logger.mock.calls);
    for (const marketPeriod of marketPeriods) expect(renderedLogs).not.toContain(marketPeriod);
  });

  it('isFullMatchPeriod accepts match periods and rejects unfamiliar labels and halves', () => {
    expect(isFullMatchPeriod(undefined, silentLogger)).toBe(true);
    expect(isFullMatchPeriod('M', silentLogger)).toBe(true);
    expect(isFullMatchPeriod('FT', silentLogger)).toBe(true);
    expect(isFullMatchPeriod('1H', silentLogger)).toBe(false);
    expect(isFullMatchPeriod('2nd Half', silentLogger)).toBe(false);
    const logger = vi.fn();
    expect(isFullMatchPeriod('SOMETHING', logger)).toBe(false);
    expect(logger).toHaveBeenCalledWith('odds period rejected', {
      reason: 'unsupported_period',
      periodHash: '866878b16560',
      periodLength: 9,
    });
  });
});
