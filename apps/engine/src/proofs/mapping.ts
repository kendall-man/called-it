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
export function mapStatValidationToParams(
  proof: unknown,
  comparator: Comparator,
  threshold: number,
): MappedValidateStatParams | null {
  const record = asRecord(proof);
  if (!record) return null;
  const ts = typeof record.ts === 'number' ? record.ts : null;
  const summary = asRecord(record.summary);
  const statToProve = asRecord(record.statToProve);
  const eventStatRoot = record.eventStatRoot;
  const statProof = Array.isArray(record.statProof) ? record.statProof : null;
  const fixtureProof = Array.isArray(record.subTreeProof) ? record.subTreeProof : null;
  const mainTreeProof = Array.isArray(record.mainTreeProof) ? record.mainTreeProof : null;
  if (
    ts === null ||
    !summary ||
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
    fixtureSummary: summary as unknown as ScoresBatchSummaryInput,
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
