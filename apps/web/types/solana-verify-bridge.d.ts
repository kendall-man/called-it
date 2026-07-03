/**
 * Ambient types for the `solana-verify-bridge` specifier.
 *
 * The specifier is never a real package: next.config.ts aliases it to
 * `@calledit/solana/dist/verify.js` when that sibling is built, and to
 * `lib/verify-fallback.ts` otherwise. Types live here (not in tsconfig
 * `paths`) so webpack resolution is owned by the alias alone — a paths
 * mapping would shadow the alias and pin the bundle to the fallback.
 *
 * This surface mirrors `packages/solana/dist/verify.d.ts`; keep in sync.
 */
declare module 'solana-verify-bridge' {
  /** Accepted encodings for a 32-byte hash arriving from TxLINE payloads. */
  export type HashInput = string | Uint8Array | readonly number[];

  /** One step of a TxLINE Merkle path (OpenAPI `ProofNode`). */
  export interface MerkleProofNode {
    hash: HashInput;
    /** true → sibling hashes on the RIGHT of the running node. */
    isRightSibling: boolean;
  }

  export interface VerifyMerkleProofInput {
    leaf: HashInput;
    proof: readonly MerkleProofNode[];
    root: HashInput;
  }

  /** Start-of-slot minute + root pairs published for one epoch day. */
  export interface DailyRootEntry {
    minuteOfDay: number | null;
    rootHex: string;
  }

  /** Defensive: malformed input returns false, never throws. */
  export function verifyMerkleProof(input: VerifyMerkleProofInput): boolean;

  export function fetchOnchainRoot(
    rpcUrl: string,
    programId: string,
    epochDay: number,
    minuteOfDay?: number,
  ): Promise<string | null>;

  /** All published scores roots for one epoch day; null when unavailable. */
  export function fetchOnchainRoots(
    rpcUrl: string,
    programId: string,
    epochDay: number,
  ): Promise<DailyRootEntry[] | null>;
}
