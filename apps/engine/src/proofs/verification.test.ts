import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyProofAgainstExpectedRoots } from './verification.js';

function sha256Hex(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part, 'hex');
  return hash.digest('hex');
}

const LEAF = '11'.repeat(32);
const SIBLING = '22'.repeat(32);
const ROOT = sha256Hex(LEAF, SIBLING);

const PROOF = {
  summary: {
    updateStats: { minTimestamp: 1_752_000_000_000 },
    eventsSubTreeRoot: LEAF,
  },
  mainTreeProof: [{ hash: SIBLING, isRightSibling: true }],
};

describe('verifyProofAgainstExpectedRoots', () => {
  it('accepts a main-tree path only when it lands on a fetched expected root', async () => {
    // Given a TxLINE-shaped proof and the matching published on-chain root
    const roots = { rootsFor: async () => [ROOT] };

    // When proof verification runs before submission
    const result = await verifyProofAgainstExpectedRoots(PROOF, roots);

    // Then the payload is eligible for a verified proof state
    expect(result).toEqual({ kind: 'verified', proof: PROOF });
  });

  it('rejects a self-consistent path when it is absent from expected roots', async () => {
    // Given a valid-looking path but an unrelated published root
    const roots = { rootsFor: async () => ['33'.repeat(32)] };

    // When the proof is checked against the root source
    const result = await verifyProofAgainstExpectedRoots(PROOF, roots);

    // Then it never becomes eligible for verified
    expect(result).toEqual({ kind: 'root_mismatch' });
  });
});
