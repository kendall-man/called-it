/**
 * Runtime list of claim types, kept type-locked to the canonical
 * ClaimType union in @calledit/market-engine.
 *
 * We deliberately do NOT import the CLAIM_TYPES value from the sibling
 * package: importing only types keeps this package's runtime (and its test
 * suite) independent of the sibling's build output. The `satisfies` clause
 * plus the exhaustiveness check below make any drift a compile error.
 */

import type { ClaimType } from '@calledit/market-engine';

export const CLAIM_TYPE_VALUES = [
  'match_winner',
  'totals_ou',
  'team_scores_n',
  'btts',
  'player_scores_n',
  'comeback',
] as const satisfies readonly ClaimType[];

/** Compile-time proof CLAIM_TYPE_VALUES covers every ClaimType member. */
type MissingClaimTypes = Exclude<ClaimType, (typeof CLAIM_TYPE_VALUES)[number]>;
const CLAIM_TYPE_LIST_IS_EXHAUSTIVE: MissingClaimTypes extends never ? true : never = true;
void CLAIM_TYPE_LIST_IS_EXHAUSTIVE;

export function isClaimType(value: unknown): value is ClaimType {
  return (
    typeof value === 'string' && (CLAIM_TYPE_VALUES as readonly string[]).includes(value)
  );
}
