/**
 * ISOMORPHIC verification module — imported by the web receipt pages as
 * `@calledit/solana/verify`. It must never import node-only modules or
 * `@solana/web3.js` (too heavy for the client bundle); on-chain reads go
 * through plain JSON-RPC `fetch`.
 */
import { sha256 } from '@noble/hashes/sha2';
import { ed25519 } from '@noble/curves/ed25519';
import {
  base58Decode,
  base58Encode,
  base64ToBytes,
  bytesEqual,
  bytesToHex,
  concatBytes,
  decodeHashInput,
  type HashInput,
} from './codecs.js';

export type { HashInput } from './codecs.js';

// ── Merkle proof verification ────────────────────────────────────────────────

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

const HASH_LEN = 32;

/**
 * Walk a sha256 Merkle path from `leaf` and check it lands on `root`.
 * Defensive by design: any malformed input returns false, never throws.
 */
export function verifyMerkleProof(input: VerifyMerkleProofInput): boolean {
  try {
    let running = decodeHashInput(input.leaf);
    if (running.length === 0) return false;
    for (const node of input.proof) {
      const sibling = decodeHashInput(node.hash);
      if (sibling.length !== HASH_LEN) return false;
      running = node.isRightSibling
        ? sha256(concatBytes(running, sibling))
        : sha256(concatBytes(sibling, running));
    }
    const root = decodeHashInput(input.root);
    return root.length === HASH_LEN && bytesEqual(running, root);
  } catch {
    return false;
  }
}

// ── PDA derivation (no @solana/web3.js — pure @noble math) ──────────────────

const PDA_MARKER = 'ProgramDerivedAddress';
const MAX_BUMP_SEED = 255;
const PUBKEY_LEN = 32;

export const DAILY_SCORES_ROOTS_SEED = 'daily_scores_roots';

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Mirrors web3.js `PublicKey.isOnCurve` (same @noble/curves call). */
function isOnCurve(candidate: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal isomorphic re-implementation of
 * `PublicKey.findProgramAddressSync` (cross-checked against web3.js in tests).
 */
export function findProgramAddressBytes(
  seeds: readonly Uint8Array[],
  programId: Uint8Array,
): { address: Uint8Array; bump: number } {
  for (let bump = MAX_BUMP_SEED; bump >= 0; bump -= 1) {
    const candidate = sha256(
      concatBytes(...seeds, Uint8Array.of(bump), programId, utf8Bytes(PDA_MARKER)),
    );
    if (!isOnCurve(candidate)) return { address: candidate, bump };
  }
  throw new Error('unable to find a viable program address bump');
}

const EPOCH_DAY_SEED_LEN = 2;
const MAX_EPOCH_DAY = 0xffff; // the on-chain insert_scores_root arg is u16

function epochDaySeed(epochDay: number): Uint8Array {
  if (!Number.isInteger(epochDay) || epochDay < 0 || epochDay > MAX_EPOCH_DAY) {
    throw new Error(`epochDay must be an integer in [0, ${MAX_EPOCH_DAY}], got ${epochDay}`);
  }
  const seed = new Uint8Array(EPOCH_DAY_SEED_LEN);
  seed[0] = epochDay & 0xff;
  seed[1] = (epochDay >> 8) & 0xff;
  return seed;
}

/**
 * Base58 address of the `daily_scores_roots` PDA for one epoch day.
 * Seeds verified empirically against devnet: ["daily_scores_roots", u16 LE epochDay].
 */
export function deriveDailyScoresRootsAddress(programId: string, epochDay: number): string {
  const programIdBytes = base58Decode(programId);
  if (programIdBytes.length !== PUBKEY_LEN) {
    throw new Error(`programId must decode to ${PUBKEY_LEN} bytes: ${programId}`);
  }
  const { address } = findProgramAddressBytes(
    [utf8Bytes(DAILY_SCORES_ROOTS_SEED), epochDaySeed(epochDay)],
    programIdBytes,
  );
  return base58Encode(address);
}

export const MS_PER_DAY = 86_400_000;

/** Days since the Unix epoch — the `epochDay` used across TxLINE. */
export function epochDayFromMs(unixMs: number): number {
  return Math.floor(unixMs / MS_PER_DAY);
}

// ── On-chain daily roots account ─────────────────────────────────────────────

/**
 * Observed devnet layout of the daily_scores_roots account (2026-07-03):
 *   [0..8)   anchor-style discriminator
 *   [8..10)  epoch_day u16 LE
 *   [10..10+N*32) N fixed 32-byte root slots, all-zero = empty
 *            (N = 288 on devnet → one slot per 5 minutes; the on-chain
 *            insert_scores_root(epoch_day, hour_of_day, minute_of_hour, root)
 *            signature implies slot = hour*slotsPerHour + minute/slotMinutes)
 *   trailing few bytes: unknown bookkeeping — ignored.
 * Parsing is defensive: anything unexpected yields null, never a throw.
 */
const ROOTS_HEADER_LEN = 10;
const EPOCH_DAY_OFFSET = 8;
const MINUTES_PER_DAY = 1440;

export interface DailyRootEntry {
  /** Start minute of the slot within the UTC day, or null when slot timing is unknown. */
  minuteOfDay: number | null;
  rootHex: string;
}

interface ParsedRootsAccount {
  entries: DailyRootEntry[];
}

function isAllZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function parseDailyScoresRootsAccount(
  data: Uint8Array,
  expectedEpochDay: number,
): ParsedRootsAccount | null {
  if (data.length < ROOTS_HEADER_LEN + HASH_LEN) return null;
  const dayInAccount =
    (data[EPOCH_DAY_OFFSET] ?? 0) | ((data[EPOCH_DAY_OFFSET + 1] ?? 0) << 8);
  if (dayInAccount !== expectedEpochDay) return null;
  const slotCount = Math.floor((data.length - ROOTS_HEADER_LEN) / HASH_LEN);
  if (slotCount < 1) return null;
  const minutesPerSlot =
    MINUTES_PER_DAY % slotCount === 0 ? MINUTES_PER_DAY / slotCount : null;
  const entries: DailyRootEntry[] = [];
  for (let slot = 0; slot < slotCount; slot += 1) {
    const start = ROOTS_HEADER_LEN + slot * HASH_LEN;
    const root = data.subarray(start, start + HASH_LEN);
    if (isAllZero(root)) continue;
    entries.push({
      minuteOfDay: minutesPerSlot === null ? null : slot * minutesPerSlot,
      rootHex: bytesToHex(root),
    });
  }
  return { entries };
}

interface JsonRpcAccountInfoResponse {
  result?: { value?: { data?: unknown } | null };
}

async function fetchAccountData(rpcUrl: string, address: string): Promise<Uint8Array | null> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [address, { encoding: 'base64', commitment: 'confirmed' }],
    }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as JsonRpcAccountInfoResponse;
  const value = payload.result?.value;
  if (!value) return null;
  const data = value.data;
  if (!Array.isArray(data) || typeof data[0] !== 'string') return null;
  return base64ToBytes(data[0]);
}

/**
 * Fetch all published scores Merkle roots for one epoch day, straight from
 * the daily_scores_roots PDA via raw JSON-RPC. Returns null when the account
 * is missing, the layout is unrecognized, or the network is unreachable.
 */
export async function fetchOnchainRoots(
  rpcUrl: string,
  programId: string,
  epochDay: number,
): Promise<DailyRootEntry[] | null> {
  try {
    const address = deriveDailyScoresRootsAddress(programId, epochDay);
    const data = await fetchAccountData(rpcUrl, address);
    if (!data) return null;
    const parsed = parseDailyScoresRootsAccount(data, epochDay);
    return parsed ? parsed.entries : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a single on-chain root (hex) for an epoch day.
 *
 * TxLINE publishes one root per 5-minute batch, so a day holds many roots.
 * Pass `minuteOfDay` (UTC minutes since midnight, e.g. from the proof's `ts`)
 * to get the most recent root published at or before that minute; omit it to
 * get the latest published root of the day. Null when unavailable or the
 * layout is unknown. When the exact publication slot of a proof is uncertain,
 * prefer `fetchOnchainRoots` and check the computed root for membership.
 */
export async function fetchOnchainRoot(
  rpcUrl: string,
  programId: string,
  epochDay: number,
  minuteOfDay?: number,
): Promise<string | null> {
  const entries = await fetchOnchainRoots(rpcUrl, programId, epochDay);
  if (!entries || entries.length === 0) return null;
  if (minuteOfDay === undefined) {
    return entries[entries.length - 1]?.rootHex ?? null;
  }
  if (!Number.isFinite(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= MINUTES_PER_DAY) {
    return null;
  }
  // Slot timing may be unknown for exotic layouts; those entries can't be
  // matched to a minute, so fall through to null rather than guess.
  let match: DailyRootEntry | null = null;
  for (const entry of entries) {
    if (entry.minuteOfDay !== null && entry.minuteOfDay <= minuteOfDay) {
      match = entry;
    }
  }
  return match ? match.rootHex : null;
}
