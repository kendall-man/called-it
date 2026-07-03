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
