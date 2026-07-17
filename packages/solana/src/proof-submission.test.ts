import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2';
import { base58Encode, bytesToHex } from './codecs.js';
import {
  buildSignedValidateStatSubmission,
  planProofSubmissionRecovery,
  rebroadcastProofSubmission,
} from './proof-submission.js';
import type { SubmitValidateStatParams } from './txoracle.js';

const PROGRAM_ID = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
const WALLET = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1));

describe('durable proof submission', () => {
  it('only permits a rebuild after full-history absence and proven blockhash expiry', () => {
    // Given an outbox signature that has no full-history status
    const absent = { ok: true, found: false } as const;

    // When the latest valid block is still live
    expect(planProofSubmissionRecovery(absent, false)).toEqual({ kind: 'rebroadcast' });

    // Then a new signed transaction becomes safe only after final expiry
    expect(planProofSubmissionRecovery(absent, true)).toEqual({ kind: 'rebuild' });
  });

  it('builds a deterministic signed validate_stat transaction before rebroadcasting its exact bytes', async () => {
    const connection = new Connection('http://127.0.0.1:8899');
    const blockhash = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => 32 - index))
      .publicKey
      .toBase58();
    vi.spyOn(connection, 'getLatestBlockhash').mockResolvedValue({
      blockhash,
      lastValidBlockHeight: 900,
    });
    const params = validateStatParams(connection);

    const first = await buildSignedValidateStatSubmission(params);
    const second = await buildSignedValidateStatSubmission(params);

    if (!first.ok || !second.ok) throw new Error('validate_stat transaction did not build');
    expect(first.submission).toEqual(second.submission);
    const parsed = Transaction.from(Buffer.from(first.submission.rawTxB64, 'base64'));
    if (parsed.signature === null) throw new Error('serialized transaction has no signature');
    expect(base58Encode(parsed.signature)).toBe(first.submission.signature);
    expect(first.submission.lastValidBlockHeight).toBe(900);

    const sent: Buffer[] = [];
    const rebroadcast = await rebroadcastProofSubmission({
      sendRawTransaction: async (rawTransaction) => {
        sent.push(rawTransaction);
        return first.submission.signature;
      },
    }, first.submission);

    expect(rebroadcast).toEqual({ ok: true, alreadyProcessed: false });
    expect(sent).toEqual([Buffer.from(first.submission.rawTxB64, 'base64')]);
  });
});

function validateStatParams(connection: Connection): SubmitValidateStatParams {
  const hash = (value: number) => bytesToHex(sha256(Uint8Array.of(value)));
  return {
    connection,
    wallet: WALLET,
    programId: PROGRAM_ID,
    ts: 1_783_100_000_000,
    fixtureSummary: {
      fixtureId: 987654321,
      updateStats: {
        updateCount: 42,
        minTimestamp: 1_783_000_000_000,
        maxTimestamp: 1_783_100_000_000,
      },
      eventsSubTreeRoot: hash(1),
    },
    fixtureProof: [{ hash: hash(2), isRightSibling: true }],
    mainTreeProof: [{ hash: hash(3), isRightSibling: false }],
    predicate: { threshold: 2, comparison: 'greaterThan' },
    statA: {
      statToProve: { key: 1, value: 3, period: 2 },
      eventStatRoot: hash(4),
      statProof: [{ hash: hash(5), isRightSibling: true }],
    },
  };
}
