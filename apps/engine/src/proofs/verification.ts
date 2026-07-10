import {
  epochDayFromMs,
  fetchOnchainRoots,
  verifyMerkleProof,
  type HashInput,
  type MerkleProofNode,
} from '@calledit/solana';

const UNIX_MS_THRESHOLD = 100_000_000_000;

export interface ExpectedScoresRootSource {
  rootsFor(timestampMs: number): Promise<readonly HashInput[] | null>;
}

export type ExpectedRootVerification =
  | { readonly kind: 'verified'; readonly proof: Readonly<Record<string, unknown>> }
  | { readonly kind: 'payload_invalid' }
  | { readonly kind: 'root_unavailable' }
  | { readonly kind: 'root_mismatch' };

export function createOnchainExpectedScoresRootSource(options: {
  readonly rpcUrl: string;
  readonly programId: string;
}): ExpectedScoresRootSource {
  return {
    async rootsFor(timestampMs) {
      const roots = await fetchOnchainRoots(
        options.rpcUrl,
        options.programId,
        epochDayFromMs(timestampMs),
      );
      return roots?.map((root) => root.rootHex) ?? null;
    },
  };
}

/**
 * Checks the proof's published main-tree path against a root read independently
 * from the chain. A root carried by the TxLINE payload is never trusted here.
 */
export async function verifyProofAgainstExpectedRoots(
  value: unknown,
  expectedRoots: ExpectedScoresRootSource,
): Promise<ExpectedRootVerification> {
  const proof = asRecord(value);
  if (proof === null) return { kind: 'payload_invalid' };

  const summary = asRecord(proof.summary);
  const updateStats = summary === null ? null : asRecord(summary.updateStats);
  const timestamp = updateStats === null ? null : timestampMs(updateStats.minTimestamp);
  const leaf = summary === null ? null : hashInput(summary.eventStatsSubTreeRoot ?? summary.eventsSubTreeRoot);
  const path = proofPath(proof.mainTreeProof);
  if (timestamp === null || leaf === null || path === null) {
    return { kind: 'payload_invalid' };
  }

  const roots = await expectedRoots.rootsFor(timestamp);
  if (roots === null || roots.length === 0) return { kind: 'root_unavailable' };
  for (const root of roots) {
    if (verifyMerkleProof({ leaf, proof: path, root })) {
      return { kind: 'verified', proof };
    }
  }
  return { kind: 'root_mismatch' };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  const milliseconds = value < UNIX_MS_THRESHOLD ? value * 1_000 : value;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function proofPath(value: unknown): readonly MerkleProofNode[] | null {
  if (!Array.isArray(value)) return null;
  const path: MerkleProofNode[] = [];
  for (const candidate of value) {
    const node = asRecord(candidate);
    if (node === null || typeof node.isRightSibling !== 'boolean') return null;
    const hash = hashInput(node.hash);
    if (hash === null) return null;
    path.push({ hash, isRightSibling: node.isRightSibling });
  }
  return path;
}

function hashInput(value: unknown): HashInput | null {
  if (typeof value === 'string' || value instanceof Uint8Array) return value;
  if (!Array.isArray(value)) return null;
  const bytes: number[] = [];
  for (const byte of value) {
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}
