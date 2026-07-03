/**
 * Pure translation from a TxLINE stat-validation response envelope to the
 * txoracle validate_stat parameters. Kept dependency-free (type-only imports)
 * so it is testable before sibling packages build.
 */

import type { Comparator } from '@calledit/market-engine';
import type {
  ProofNodeInput,
  ScoresBatchSummaryInput,
  ScoreStatInput,
  SubmitValidateStatParams,
  TraderPredicateInput,
} from '@calledit/solana';

export type MappedValidateStatParams = Omit<
  SubmitValidateStatParams,
  'connection' | 'wallet' | 'programId'
>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** gte 2 ⇒ "> 1", lte 2 ⇒ "< 3", eq 2 ⇒ "= 2" — the on-chain comparisons are strict. */
export function predicateFor(comparator: Comparator, threshold: number): TraderPredicateInput {
  switch (comparator) {
    case 'gte':
      return { threshold: threshold - 1, comparison: 'greaterThan' };
    case 'lte':
      return { threshold: threshold + 1, comparison: 'lessThan' };
    case 'eq':
      return { threshold, comparison: 'equalTo' };
  }
}

/**
 * Best-effort mapping; null when the payload is missing required pieces (the
 * proof worker then marks the badge 'unavailable' — never blocks settlement).
 */
/**
 * The live devnet API names the summary's sub-tree root `eventStatsSubTreeRoot`
 * (observed 2026-07-03 on the first real proof), while the on-chain arg —
 * and older docs — call it `eventsSubTreeRoot`. Accept both; passing the raw
 * summary through unmapped is how the first live submission failed with
 * "unsupported hash encoding" (undefined field).
 */
function normalizeSummary(summary: Record<string, unknown>): ScoresBatchSummaryInput | null {
  const updateStats = asRecord(summary.updateStats);
  const subTreeRoot = summary.eventStatsSubTreeRoot ?? summary.eventsSubTreeRoot;
  const fixtureId = summary.fixtureId;
  if (
    !updateStats ||
    subTreeRoot === undefined ||
    subTreeRoot === null ||
    (typeof fixtureId !== 'number' && typeof fixtureId !== 'bigint')
  ) {
    return null;
  }
  return {
    fixtureId,
    updateStats: updateStats as ScoresBatchSummaryInput['updateStats'],
    eventsSubTreeRoot: subTreeRoot as ScoresBatchSummaryInput['eventsSubTreeRoot'],
  };
}

export function mapStatValidationToParams(
  proof: unknown,
  comparator: Comparator,
  threshold: number,
): MappedValidateStatParams | null {
  const record = asRecord(proof);
  if (!record) return null;
  const summary = asRecord(record.summary);
  // validate_stat requires ts == update_stats.min_timestamp — the program's
  // "timestamp in the snapshot payload" (established empirically 2026-07-04:
  // the response's top-level ts and max_timestamp are both rejected with
  // TimestampMismatch; min_timestamp verified on-chain, tx 3EH5WWei…).
  const updateStats = summary ? asRecord(summary.updateStats) : null;
  const minTimestamp =
    updateStats && typeof updateStats.minTimestamp === 'number'
      ? updateStats.minTimestamp
      : null;
  const ts = minTimestamp ?? (typeof record.ts === 'number' ? record.ts : null);
  const statToProve = asRecord(record.statToProve);
  const eventStatRoot = record.eventStatRoot;
  const statProof = Array.isArray(record.statProof) ? record.statProof : null;
  const fixtureProof = Array.isArray(record.subTreeProof) ? record.subTreeProof : null;
  const mainTreeProof = Array.isArray(record.mainTreeProof) ? record.mainTreeProof : null;
  const fixtureSummary = summary ? normalizeSummary(summary) : null;
  if (
    ts === null ||
    !fixtureSummary ||
    !statToProve ||
    eventStatRoot === undefined ||
    eventStatRoot === null ||
    !statProof ||
    !fixtureProof ||
    !mainTreeProof
  ) {
    return null;
  }
  return {
    ts,
    fixtureSummary,
    fixtureProof: fixtureProof as unknown as ProofNodeInput[],
    mainTreeProof: mainTreeProof as unknown as ProofNodeInput[],
    predicate: predicateFor(comparator, threshold),
    statA: {
      statToProve: statToProve as unknown as ScoreStatInput,
      eventStatRoot: eventStatRoot as ProofNodeInput['hash'],
      statProof: statProof as unknown as ProofNodeInput[],
    },
  };
}
