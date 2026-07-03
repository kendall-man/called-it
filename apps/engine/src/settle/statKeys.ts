/**
 * On-chain team-level stat keys (audit 2026-07-02: keys 1–8 cover goals,
 * yellows, reds, corners per participant; period variant = period*1000+key).
 *
 * The 1..8 assignment order below (goals p1/p2, yellows p1/p2, reds p1/p2,
 * corners p1/p2) is the documented ordering — confirm empirically on the
 * day-1 spike before trusting proof lookups in production.
 */

import type { MarketSpec } from '@calledit/market-engine';

export const TEAM_STAT_KEYS = {
  goals: { 1: 1, 2: 2 },
  yellowCards: { 1: 3, 2: 4 },
  redCards: { 1: 5, 2: 6 },
  corners: { 1: 7, 2: 8 },
} as const;

/**
 * The stat key whose Merkle proof substantiates a settled market, or null
 * when the spec has no single team-stat anchor (player claims are
 * oracle_resolved and never reach the proof worker).
 */
export function statKeyForSpec(spec: MarketSpec): number | null {
  if (spec.trustTier !== 'chain_proven') return null;
  if (spec.entityRef.kind === 'team') {
    return TEAM_STAT_KEYS.goals[spec.entityRef.participant];
  }
  // Whole-match specs (totals/btts) anchor on participant-1 goals; the
  // receipt page lists both teams' evidence seqs regardless.
  return TEAM_STAT_KEYS.goals[1];
}
