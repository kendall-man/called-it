import { describe, expect, it } from 'vitest';
import { mapFixtureRecord, toMs } from './fixtureMap.js';

describe('toMs', () => {
  it('promotes second-precision timestamps to ms and passes ms through', () => {
    expect(toMs(1_752_000_000)).toBe(1_752_000_000_000);
    expect(toMs(1_752_000_000_000)).toBe(1_752_000_000_000);
  });
});

describe('mapFixtureRecord', () => {
  it('maps the PascalCase wire record to the fixtures upsert row', () => {
    const row = mapFixtureRecord({
      FixtureId: 9001,
      StartTime: 1_752_000_000,
      Participant1Id: 11,
      Participant1: 'France',
      Participant2Id: 22,
      Participant2: 'Brazil',
      CompetitionId: 77,
    });
    expect(row).toEqual({
      fixture_id: 9001,
      competition_id: 77,
      p1_id: 11,
      p1_name: 'France',
      p2_id: 22,
      p2_name: 'Brazil',
      kickoff_at: new Date(1_752_000_000_000).toISOString(),
    });
  });

  it('defaults a missing competition id to null', () => {
    const row = mapFixtureRecord({
      FixtureId: 1,
      StartTime: 1_752_000_000_000,
      Participant1Id: 1,
      Participant1: 'A',
      Participant2Id: 2,
      Participant2: 'B',
    });
    expect(row.competition_id).toBeNull();
  });
});
