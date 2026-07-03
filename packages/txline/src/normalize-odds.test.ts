import { describe, expect, it, vi } from 'vitest';
import {
  buildOddsSuspensionEvent,
  combineOddsSnapshot,
  isFullMatchPeriod,
  isOddsSuspended,
  normalizeOdds,
  parseTotalsLine,
} from './normalize-odds.js';
import { silentLogger } from './logging.js';
import { oddsRecordSchema } from './schemas.js';
import { FIXTURE_ID, KICKOFF_MS, oddsRecord, totalsRecord } from './test-fixtures.js';

const normalize = (payload: unknown) => normalizeOdds(payload, { logger: silentLogger });

describe('normalizeOdds — 1X2', () => {
  it('extracts demargined home/draw/away probabilities and pins provenance', () => {
    const inputs = normalize(oddsRecord());
    expect(inputs).not.toBeNull();
    expect(inputs?.p1x2?.home).toBeCloseTo(0.455, 6);
    expect(inputs?.p1x2?.draw).toBeCloseTo(0.281, 6);
    expect(inputs?.p1x2?.away).toBeCloseTo(0.264, 6);
    expect(inputs?.totals).toBeNull();
    expect(inputs?.oddsMessageId).toBe('msg-1');
    expect(inputs?.oddsTsMs).toBe(KICKOFF_MS - 600_000);
  });

  it('maps outcomes by PriceNames, not position', () => {
    const inputs = normalize(
      oddsRecord({ PriceNames: ['X', '2', '1'], Pct: ['28.100', '26.400', '45.500'] }),
    );
    expect(inputs?.p1x2?.home).toBeCloseTo(0.455, 6);
    expect(inputs?.p1x2?.draw).toBeCloseTo(0.281, 6);
  });

  it('assumes home/draw/away order when PriceNames is missing', () => {
    const inputs = normalize(oddsRecord({ PriceNames: undefined }));
    expect(inputs?.p1x2?.home).toBeCloseTo(0.455, 6);
  });

  it('returns null when any 1X2 percentage is NA', () => {
    expect(normalize(oddsRecord({ Pct: ['45.500', 'NA', '26.400'] }))).toBeNull();
  });
});

describe('normalizeOdds — totals', () => {
  it('extracts the line and over probability', () => {
    const inputs = normalize(totalsRecord());
    expect(inputs?.p1x2).toBeNull();
    expect(inputs?.totals?.line).toBe(2.5);
    expect(inputs?.totals?.overProb).toBeCloseTo(0.52, 6);
    expect(inputs?.oddsMessageId).toBe('msg-totals-1');
  });

  it('rejects quarter lines whose percentages are NA', () => {
    expect(normalize(totalsRecord({ MarketParameters: 'total=2.25', Pct: ['NA', 'NA'] }))).toBeNull();
  });

  it('rejects totals without a parseable line', () => {
    expect(normalize(totalsRecord({ MarketParameters: undefined }))).toBeNull();
  });
});

describe('normalizeOdds — filtering and defensiveness', () => {
  it('rejects half-time markets', () => {
    expect(normalize(oddsRecord({ MarketPeriod: '1H' }))).toBeNull();
    expect(normalize(oddsRecord({ MarketPeriod: 'HT' }))).toBeNull();
  });

  it('rejects suspended records', () => {
    expect(normalize(oddsRecord({ GameState: 'Suspended' }))).toBeNull();
    expect(normalize(oddsRecord({ GameState: 'OTB' }))).toBeNull();
  });

  it('classifies unknown SuperOddsType structurally via PriceNames, with a log', () => {
    const logger = vi.fn();
    const inputs = normalizeOdds(
      oddsRecord({ SuperOddsType: 'MYSTERY', PriceNames: ['Home', 'Draw', 'Away'] }),
      { logger },
    );
    expect(inputs?.p1x2).not.toBeNull();
    expect(logger).toHaveBeenCalledWith(
      'unknown SuperOddsType',
      expect.objectContaining({ superOddsType: 'MYSTERY' }),
    );
  });

  it('returns null and logs for unknown SuperOddsType without structural hints', () => {
    const logger = vi.fn();
    const inputs = normalizeOdds(
      oddsRecord({ SuperOddsType: 'MYSTERY', PriceNames: ['Alpha', 'Beta'] }),
      { logger },
    );
    expect(inputs).toBeNull();
    expect(logger).toHaveBeenCalledWith('unknown SuperOddsType', expect.anything());
  });

  it('returns null and logs for unparseable payloads', () => {
    const logger = vi.fn();
    expect(normalizeOdds({ nonsense: true }, { logger })).toBeNull();
    expect(logger).toHaveBeenCalledWith('skipping unparseable odds record', expect.anything());
  });
});

describe('helpers', () => {
  it('parseTotalsLine finds the first decimal number', () => {
    expect(parseTotalsLine('2.5')).toBe(2.5);
    expect(parseTotalsLine('total=2.5')).toBe(2.5);
    expect(parseTotalsLine('hcp=-0.5')).toBe(-0.5);
    expect(parseTotalsLine('no numbers')).toBeNull();
    expect(parseTotalsLine(undefined)).toBeNull();
  });

  it('isFullMatchPeriod accepts match periods and unfamiliar labels, rejects halves', () => {
    expect(isFullMatchPeriod(undefined, silentLogger)).toBe(true);
    expect(isFullMatchPeriod('M', silentLogger)).toBe(true);
    expect(isFullMatchPeriod('FT', silentLogger)).toBe(true);
    expect(isFullMatchPeriod('1H', silentLogger)).toBe(false);
    expect(isFullMatchPeriod('2nd Half', silentLogger)).toBe(false);
    const logger = vi.fn();
    expect(isFullMatchPeriod('SOMETHING', logger)).toBe(true);
    expect(logger).toHaveBeenCalled();
  });

  it('isOddsSuspended detects off-the-board states', () => {
    const parse = (gameState?: string) => oddsRecordSchema.parse(oddsRecord({ GameState: gameState }));
    expect(isOddsSuspended(parse('Suspended'))).toBe(true);
    expect(isOddsSuspended(parse('off the board'))).toBe(true);
    expect(isOddsSuspended(parse('Running'))).toBe(false);
    expect(isOddsSuspended(parse(undefined))).toBe(false);
  });
});

describe('combineOddsSnapshot', () => {
  it('merges the latest 1X2 with the main totals line and pins from the 1X2 record', () => {
    const snapshot = [
      oddsRecord({ MessageId: 'm-old', Ts: 100 }),
      oddsRecord({ MessageId: 'm-new', Ts: 200 }),
      totalsRecord({
        MessageId: 'm-t15',
        Ts: 150,
        MarketParameters: 'total=1.5',
        Pct: ['78.000', '22.000'],
      }),
      totalsRecord({
        MessageId: 'm-t25',
        Ts: 140,
        MarketParameters: 'total=2.5',
        Pct: ['51.000', '49.000'],
      }),
    ];
    const inputs = combineOddsSnapshot(snapshot, { logger: silentLogger });
    expect(inputs?.p1x2?.home).toBeCloseTo(0.455, 6);
    expect(inputs?.totals?.line).toBe(2.5);
    expect(inputs?.totals?.overProb).toBeCloseTo(0.51, 6);
    expect(inputs?.oddsMessageId).toBe('m-new');
    expect(inputs?.oddsTsMs).toBe(200);
  });

  it('pins from the totals record when no 1X2 is present', () => {
    const inputs = combineOddsSnapshot([totalsRecord({ MessageId: 'm-t', Ts: 300 })], {
      logger: silentLogger,
    });
    expect(inputs?.p1x2).toBeNull();
    expect(inputs?.oddsMessageId).toBe('m-t');
    expect(inputs?.oddsTsMs).toBe(300);
  });

  it('returns null when nothing in the snapshot is usable', () => {
    expect(combineOddsSnapshot([], { logger: silentLogger })).toBeNull();
    expect(
      combineOddsSnapshot([oddsRecord({ GameState: 'Suspended' })], { logger: silentLogger }),
    ).toBeNull();
  });
});

describe('devnet wire shapes (empirical 2026-07-03, synthetic values)', () => {
  // Field shapes mirror the live devnet feed exactly; every value is invented.
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
    // The integer line sits exactly at even money but its Pct is
    // push-conditioned; the half line must win main-line selection anyway.
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
    // The half=1 1X2 has the newer Ts but must lose to the full-match record.
    expect(inputs?.oddsMessageId).toBe('w-1x2-full');
    expect(inputs?.p1x2?.home).toBeCloseTo(0.5, 6);
    expect(inputs?.totals?.line).toBe(2.5);
  });
});

describe('buildOddsSuspensionEvent', () => {
  it('builds an odds_suspension MatchEvent using Ts as the pseudo-seq', () => {
    const record = oddsRecordSchema.parse(oddsRecord({ GameState: 'Suspended', Ts: 12345 }));
    const event = buildOddsSuspensionEvent(record, 99999);
    expect(event.kind).toBe('odds_suspension');
    expect(event.fixtureId).toBe(FIXTURE_ID);
    expect(event.seq).toBe(12345);
    expect(event.tsMs).toBe(12345);
    expect(event.receivedAtMs).toBe(99999);
    expect(event.phase).toBe('NS');
    expect(event.score.p1Goals90).toBeNull();
  });

  it('uses enrichment phase and score when provided', () => {
    const record = oddsRecordSchema.parse(oddsRecord({ GameState: 'Suspended' }));
    const score = {
      p1: { goals: 1, yellowCards: 0, redCards: 0, corners: 2 },
      p2: { goals: 0, yellowCards: 1, redCards: 0, corners: 1 },
      p1Goals90: 1,
      p2Goals90: 0,
    };
    const event = buildOddsSuspensionEvent(record, 1, { phase: 'H2', score });
    expect(event.phase).toBe('H2');
    expect(event.score).toEqual(score);
  });
});
