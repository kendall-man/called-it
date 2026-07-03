/**
 * Build-time stand-in for `@calledit/solana/verify`.
 *
 * All app code imports `solana-verify-bridge`; next.config.ts aliases that
 * specifier to the real compiled module when `packages/solana` has been
 * built, and to this file otherwise — keeping the app buildable with the
 * sibling unbuilt. Types come from the ambient declaration in
 * types/solana-verify-bridge.d.ts, which this module must keep satisfying.
 *
 * The fallback behavior is deliberate: "no roots found" plus a failing
 * verify funnel the trust badge into its graceful
 * "verification unavailable" state.
 */
import type { DailyRootEntry, VerifyMerkleProofInput } from 'solana-verify-bridge';

export type {
  DailyRootEntry,
  HashInput,
  MerkleProofNode,
  VerifyMerkleProofInput,
} from 'solana-verify-bridge';

export function verifyMerkleProof(_input: VerifyMerkleProofInput): boolean {
  return false;
}

export async function fetchOnchainRoot(
  _rpcUrl: string,
  _programId: string,
  _epochDay: number,
  _minuteOfDay?: number,
): Promise<string | null> {
  return null;
}

export async function fetchOnchainRoots(
  _rpcUrl: string,
  _programId: string,
  _epochDay: number,
): Promise<DailyRootEntry[] | null> {
  return null;
}
