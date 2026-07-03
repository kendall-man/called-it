/**
 * Pure mapping from TxLINE FixtureRecord (PascalCase wire shape) to the
 * fixtures-table upsert row. Type-only imports keep this testable before the
 * sibling packages build.
 */

import type { FixtureRecord } from '@calledit/txline';
import type { FixtureUpsert } from '../ports.js';

/** TxLINE timestamps arrive as seconds or ms depending on endpoint — normalize to ms. */
export function toMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

export function mapFixtureRecord(record: FixtureRecord): FixtureUpsert {
  return {
    fixture_id: record.FixtureId,
    competition_id: record.CompetitionId ?? null,
    p1_id: record.Participant1Id,
    p1_name: record.Participant1,
    p2_id: record.Participant2Id,
    p2_name: record.Participant2,
    kickoff_at: new Date(toMs(record.StartTime)).toISOString(),
  };
}
