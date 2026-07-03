import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  base58Decode,
  base58Encode,
  bytesToHex,
  concatBytes,
  decodeHashInput,
} from './codecs.js';
import {
  DAILY_SCORES_ROOTS_SEED,
  deriveDailyScoresRootsAddress,
  epochDayFromMs,
  fetchOnchainRoot,
  fetchOnchainRoots,
  findProgramAddressBytes,
  verifyMerkleProof,
  type MerkleProofNode,
} from './verify.js';

const PROGRAM_ID = '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J';
const RPC_URL = 'https://rpc.invalid.test';

// ── codecs ───────────────────────────────────────────────────────────────────

describe('base58 codec', () => {
  it('roundtrips against web3.js PublicKey encoding', () => {
    const pubkey = new PublicKey(PROGRAM_ID);
    expect(base58Decode(PROGRAM_ID)).toEqual(new Uint8Array(pubkey.toBytes()));
    expect(base58Encode(pubkey.toBytes())).toBe(PROGRAM_ID);
  });

  it('handles leading zero bytes like the reference implementation', () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 3]);
    const encoded = base58Encode(bytes);
    expect(encoded.startsWith('11')).toBe(true);
    expect(base58Decode(encoded)).toEqual(bytes);
  });

  it('roundtrips random keypair secrets', () => {
    for (let i = 0; i < 5; i += 1) {
      const secret = Keypair.generate().secretKey;
      expect(base58Decode(base58Encode(secret))).toEqual(secret);
    }
  });

  it('rejects invalid base58 characters', () => {
    expect(() => base58Decode('0OIl')).toThrow(/invalid base58/);
  });
});

describe('decodeHashInput', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);

  it('accepts hex, base64, Uint8Array and number[]', () => {
    const hex = bytesToHex(bytes);
    const b64 = Buffer.from(bytes).toString('base64');
    expect(decodeHashInput(hex)).toEqual(bytes);
    expect(decodeHashInput(b64)).toEqual(bytes);
    expect(decodeHashInput(bytes)).toEqual(bytes);
    expect(decodeHashInput(Array.from(bytes))).toEqual(bytes);
  });
});

// ── merkle verification against a hand-built synthetic tree ─────────────────

/** leaves L0..L3 → N0=H(L0||L1), N1=H(L2||L3) → root=H(N0||N1) */
function syntheticTree() {
  const leaves = [0, 1, 2, 3].map((n) => sha256(Uint8Array.of(n)));
  const n0 = sha256(concatBytes(leaves[0]!, leaves[1]!));
  const n1 = sha256(concatBytes(leaves[2]!, leaves[3]!));
  const root = sha256(concatBytes(n0, n1));
  return { leaves, n0, n1, root };
}

describe('verifyMerkleProof', () => {
  const { leaves, n0, n1, root } = syntheticTree();

  it('accepts a valid left-branch proof (leaf L0)', () => {
    const proof: MerkleProofNode[] = [
      { hash: leaves[1]!, isRightSibling: true },
      { hash: n1, isRightSibling: true },
    ];
    expect(verifyMerkleProof({ leaf: leaves[0]!, proof, root })).toBe(true);
  });

  it('accepts a valid mixed-position proof (leaf L2)', () => {
    const proof: MerkleProofNode[] = [
      { hash: leaves[3]!, isRightSibling: true },
      { hash: n0, isRightSibling: false },
    ];
    expect(verifyMerkleProof({ leaf: leaves[2]!, proof, root })).toBe(true);
  });

  it('accepts hex- and base64-encoded inputs interchangeably', () => {
    const proof: MerkleProofNode[] = [
      { hash: bytesToHex(leaves[3]!), isRightSibling: true },
      { hash: Buffer.from(n0).toString('base64'), isRightSibling: false },
    ];
    expect(
      verifyMerkleProof({ leaf: bytesToHex(leaves[2]!), proof, root: bytesToHex(root) }),
    ).toBe(true);
  });

  it('rejects a proof with a flipped sibling position', () => {
    const proof: MerkleProofNode[] = [
      { hash: leaves[3]!, isRightSibling: false },
      { hash: n0, isRightSibling: false },
    ];
    expect(verifyMerkleProof({ leaf: leaves[2]!, proof, root })).toBe(false);
  });

  it('rejects a tampered leaf and a tampered root', () => {
    const proof: MerkleProofNode[] = [
      { hash: leaves[3]!, isRightSibling: true },
      { hash: n0, isRightSibling: false },
    ];
    expect(verifyMerkleProof({ leaf: leaves[1]!, proof, root })).toBe(false);
    const wrongRoot = Uint8Array.from(root);
    wrongRoot[0] = (wrongRoot[0]! + 1) & 0xff;
    expect(verifyMerkleProof({ leaf: leaves[2]!, proof, root: wrongRoot })).toBe(false);
  });

  it('returns false (never throws) on malformed input', () => {
    expect(verifyMerkleProof({ leaf: 'not-a-hash!!!', proof: [], root })).toBe(false);
    expect(
      verifyMerkleProof({
        leaf: leaves[0]!,
        proof: [{ hash: Uint8Array.of(1, 2, 3), isRightSibling: true }],
        root,
      }),
    ).toBe(false);
  });

  it('verifies leaf === root for an empty proof', () => {
    expect(verifyMerkleProof({ leaf: root, proof: [], root })).toBe(true);
  });
});

// ── PDA derivation parity with web3.js ───────────────────────────────────────

describe('daily_scores_roots PDA derivation', () => {
  it.each([0, 1, 20637, 65535])('matches web3.js for epochDay %i', (epochDay) => {
    const seed = Buffer.alloc(2);
    seed.writeUInt16LE(epochDay);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from(DAILY_SCORES_ROOTS_SEED), seed],
      new PublicKey(PROGRAM_ID),
    );
    expect(deriveDailyScoresRootsAddress(PROGRAM_ID, epochDay)).toBe(expected.toBase58());
  });

  it('matches web3.js for arbitrary seeds', () => {
    const programId = new PublicKey(PROGRAM_ID);
    const seeds = [Buffer.from('pricing_matrix')];
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(seeds, programId);
    const { address, bump } = findProgramAddressBytes(
      [Uint8Array.from(seeds[0]!)],
      programId.toBytes(),
    );
    expect(base58Encode(address)).toBe(expected.toBase58());
    expect(bump).toBe(expectedBump);
  });

  it('rejects out-of-range epoch days', () => {
    expect(() => deriveDailyScoresRootsAddress(PROGRAM_ID, -1)).toThrow(/epochDay/);
    expect(() => deriveDailyScoresRootsAddress(PROGRAM_ID, 70000)).toThrow(/epochDay/);
  });
});

describe('epochDayFromMs', () => {
  it('converts unix ms to days since epoch', () => {
    expect(epochDayFromMs(0)).toBe(0);
    expect(epochDayFromMs(86_400_000)).toBe(1);
    expect(epochDayFromMs(1_783_000_000_000)).toBe(20636);
  });
});

// ── fetchOnchainRoot against a mocked JSON-RPC endpoint ──────────────────────

const EPOCH_DAY = 20637;
const SLOT_COUNT = 288; // matches the observed devnet account (5-minute slots)
const HEADER_LEN = 10;
const ROOT_LEN = 32;

function syntheticRootsAccount(rootsBySlot: Record<number, Uint8Array>): string {
  const data = Buffer.alloc(HEADER_LEN + SLOT_COUNT * ROOT_LEN + 6);
  Buffer.from('deadbeefcafef00d', 'hex').copy(data, 0); // arbitrary discriminator
  data.writeUInt16LE(EPOCH_DAY, 8);
  for (const [slot, root] of Object.entries(rootsBySlot)) {
    Buffer.from(root).copy(data, HEADER_LEN + Number(slot) * ROOT_LEN);
  }
  return data.toString('base64');
}

function mockRpc(accountDataB64: string | null, capture?: { address?: string }) {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { params?: [string] };
    if (capture) capture.address = body.params?.[0];
    return {
      ok: true,
      json: async () => ({
        result: {
          value:
            accountDataB64 === null ? null : { data: [accountDataB64, 'base64'] },
        },
      }),
    };
  });
}

describe('fetchOnchainRoot', () => {
  afterEach(() => vi.unstubAllGlobals());

  const rootA = sha256(Uint8Array.of(0xaa)); // slot 5 → minute 25
  const rootB = sha256(Uint8Array.of(0xbb)); // slot 100 → minute 500

  it('queries the derived PDA and returns the latest root by default', async () => {
    const capture: { address?: string } = {};
    vi.stubGlobal('fetch', mockRpc(syntheticRootsAccount({ 5: rootA, 100: rootB }), capture));
    const root = await fetchOnchainRoot(RPC_URL, PROGRAM_ID, EPOCH_DAY);
    expect(root).toBe(bytesToHex(rootB));
    expect(capture.address).toBe(deriveDailyScoresRootsAddress(PROGRAM_ID, EPOCH_DAY));
  });

  it('selects the most recent root at or before a given minute', async () => {
    vi.stubGlobal('fetch', mockRpc(syntheticRootsAccount({ 5: rootA, 100: rootB })));
    expect(await fetchOnchainRoot(RPC_URL, PROGRAM_ID, EPOCH_DAY, 27)).toBe(bytesToHex(rootA));
    expect(await fetchOnchainRoot(RPC_URL, PROGRAM_ID, EPOCH_DAY, 499)).toBe(bytesToHex(rootA));
    expect(await fetchOnchainRoot(RPC_URL, PROGRAM_ID, EPOCH_DAY, 500)).toBe(bytesToHex(rootB));
    // No root published at or before minute 3.
    expect(await fetchOnchainRoot(RPC_URL, PROGRAM_ID, EPOCH_DAY, 3)).toBeNull();
  });

  it('returns null when the account does not exist', async () => {
    vi.stubGlobal('fetch', mockRpc(null));
    expect(await fetchOnchainRoot(RPC_URL, PROGRAM_ID, EPOCH_DAY)).toBeNull();
  });

  it('returns null on an unknown layout (wrong day, truncated data)', async () => {
    const wrongDay = Buffer.from(
      Buffer.from(syntheticRootsAccount({ 5: rootA }), 'base64'),
    );
    wrongDay.writeUInt16LE(EPOCH_DAY + 1, 8);
    vi.stubGlobal('fetch', mockRpc(wrongDay.toString('base64')));
    expect(await fetchOnchainRoot(RPC_URL, PROGRAM_ID, EPOCH_DAY)).toBeNull();

    vi.stubGlobal('fetch', mockRpc(Buffer.from('too short').toString('base64')));
    expect(await fetchOnchainRoot(RPC_URL, PROGRAM_ID, EPOCH_DAY)).toBeNull();
  });

  it('returns null instead of throwing on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    expect(await fetchOnchainRoot(RPC_URL, PROGRAM_ID, EPOCH_DAY)).toBeNull();
  });

  it('exposes all published roots with slot minutes via fetchOnchainRoots', async () => {
    vi.stubGlobal('fetch', mockRpc(syntheticRootsAccount({ 5: rootA, 100: rootB })));
    const entries = await fetchOnchainRoots(RPC_URL, PROGRAM_ID, EPOCH_DAY);
    expect(entries).toEqual([
      { minuteOfDay: 25, rootHex: bytesToHex(rootA) },
      { minuteOfDay: 500, rootHex: bytesToHex(rootB) },
    ]);
  });

  it('verifies an end-to-end proof against the fetched root', async () => {
    const { leaves, n0, root } = syntheticTree();
    vi.stubGlobal('fetch', mockRpc(syntheticRootsAccount({ 12: root })));
    const onchainRoot = await fetchOnchainRoot(RPC_URL, PROGRAM_ID, EPOCH_DAY);
    expect(onchainRoot).not.toBeNull();
    expect(
      verifyMerkleProof({
        leaf: leaves[2]!,
        proof: [
          { hash: leaves[3]!, isRightSibling: true },
          { hash: n0, isRightSibling: false },
        ],
        root: onchainRoot!,
      }),
    ).toBe(true);
  });
});

describe('verify module stays isomorphic', () => {
  it('does not import node-only modules or web3.js', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('./verify.ts', import.meta.url), 'utf8');
    const codecsSource = await fs.readFile(new URL('./codecs.ts', import.meta.url), 'utf8');
    for (const text of [source, codecsSource]) {
      expect(text).not.toMatch(/from 'node:/);
      expect(text).not.toMatch(/from '@solana\/web3\.js'/);
      expect(text).not.toMatch(/from '@coral-xyz/);
      expect(text).not.toMatch(/Buffer\./);
    }
  });
});
