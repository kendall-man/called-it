import { describe, expect, it } from 'vitest';
import { mapStatValidationToParams, predicateFor } from './mapping.js';

const NODE = { hash: 'ab'.repeat(32), isRightSibling: false };

const FULL_RESPONSE = {
  ts: 1_752_000_000_000,
  statToProve: { key: 1, value: 2, period: 0 },
  eventStatRoot: 'cd'.repeat(32),
  statProof: [NODE],
  subTreeProof: [NODE, NODE],
  mainTreeProof: [NODE],
  summary: {
    fixtureId: 9001,
    updateStats: { updateCount: 12, minTimestamp: 1, maxTimestamp: 2 },
    eventsSubTreeRoot: 'ef'.repeat(32),
  },
};

describe('predicateFor', () => {
  it('translates inclusive comparators to strict on-chain comparisons', () => {
    expect(predicateFor('gte', 2)).toEqual({ threshold: 1, comparison: 'greaterThan' });
    expect(predicateFor('lte', 2)).toEqual({ threshold: 3, comparison: 'lessThan' });
    expect(predicateFor('eq', 2)).toEqual({ threshold: 2, comparison: 'equalTo' });
  });
});

describe('mapStatValidationToParams', () => {
  it('maps a complete stat-validation envelope with ts = min_timestamp (on-chain contract)', () => {
    const mapped = mapStatValidationToParams(FULL_RESPONSE, 'gte', 2);
    expect(mapped).not.toBeNull();
    expect(mapped?.ts).toBe(FULL_RESPONSE.summary.updateStats.minTimestamp);
    expect(mapped?.predicate).toEqual({ threshold: 1, comparison: 'greaterThan' });
    expect(mapped?.statA.statToProve).toEqual({ key: 1, value: 2, period: 0 });
    expect(mapped?.fixtureProof).toHaveLength(2);
  });

  it('maps the LIVE wire summary field name eventStatsSubTreeRoot (devnet 2026-07-03)', () => {
    // The first real proof failed on-chain submission because the live API
    // names the summary root eventStatsSubTreeRoot, not eventsSubTreeRoot,
    // and hashes arrive as number[32], not hex strings.
    const liveShaped = {
      ...FULL_RESPONSE,
      eventStatRoot: Array.from({ length: 32 }, (_, i) => i),
      statProof: [{ hash: Array.from({ length: 32 }, () => 7), isRightSibling: true }],
      summary: {
        fixtureId: 9001,
        updateStats: { updateCount: 12, minTimestamp: 1, maxTimestamp: 2 },
        eventStatsSubTreeRoot: Array.from({ length: 32 }, () => 9),
      },
    };
    const mapped = mapStatValidationToParams(liveShaped, 'eq', 2);
    expect(mapped).not.toBeNull();
    expect(mapped?.fixtureSummary.eventsSubTreeRoot).toEqual(
      Array.from({ length: 32 }, () => 9),
    );
  });

  it('returns null when the summary carries neither sub-tree-root spelling', () => {
    const broken = {
      ...FULL_RESPONSE,
      summary: { fixtureId: 9001, updateStats: { updateCount: 1, minTimestamp: 1, maxTimestamp: 2 } },
    };
    expect(mapStatValidationToParams(broken, 'gte', 2)).toBeNull();
  });

  it('returns null (badge downgrades honestly) when required pieces are missing', () => {
    expect(mapStatValidationToParams(null, 'gte', 2)).toBeNull();
    expect(mapStatValidationToParams({}, 'gte', 2)).toBeNull();
    // Missing top-level ts alone is fine (minTimestamp is the real contract);
    // null only when BOTH timestamp sources are absent.
    const noMin = {
      ...FULL_RESPONSE,
      summary: { ...FULL_RESPONSE.summary, updateStats: { updateCount: 1 } },
    };
    expect(mapStatValidationToParams({ ...noMin, ts: undefined }, 'gte', 2)).toBeNull();
    expect(
      mapStatValidationToParams({ ...FULL_RESPONSE, mainTreeProof: undefined }, 'gte', 2),
    ).toBeNull();
    expect(
      mapStatValidationToParams({ ...FULL_RESPONSE, statToProve: 'not-an-object' }, 'gte', 2),
    ).toBeNull();
  });
});
