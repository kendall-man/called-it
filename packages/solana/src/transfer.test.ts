import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram, SystemInstruction, Transaction } from '@solana/web3.js';
import { base58Decode, base58Encode } from './codecs.js';
import {
  broadcastRawTx,
  buildSolTransfer,
  getSigStatus,
  isBlockheightExceeded,
  resolveResubmitAction,
  type BroadcastRpc,
  type BuildSolTransferParams,
  type SigStatusKnown,
  type SigStatusRpc,
} from './transfer.js';

// Invented, deterministic identities — never dialed against a real cluster.
const TREASURY = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const DEST = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 101)).publicKey;
// Any 32 bytes base58-encode into a plausible blockhash.
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(9));
const LAST_VALID_BLOCK_HEIGHT = 250_000_000;
const SIGNATURE_LEN = 64;

function params(overrides: Partial<BuildSolTransferParams> = {}): BuildSolTransferParams {
  return {
    from: TREASURY,
    to: DEST,
    lamports: 12_345_678n,
    recentBlockhash: BLOCKHASH,
    lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    ...overrides,
  };
}

describe('buildSolTransfer', () => {
  it('signs offline and returns the signature before any broadcast', () => {
    const result = buildSolTransfer(params());
    if (!result.ok) throw new Error(result.error);
    expect(base58Decode(result.sig)).toHaveLength(SIGNATURE_LEN);

    const tx = Transaction.from(Buffer.from(result.rawTxB64, 'base64'));
    expect(tx.verifySignatures()).toBe(true);
    expect(base58Encode(tx.signature!)).toBe(result.sig);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.feePayer?.equals(TREASURY.publicKey)).toBe(true);

    const ix = tx.instructions[0]!;
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    const decoded = SystemInstruction.decodeTransfer(ix);
    expect(decoded.fromPubkey.equals(TREASURY.publicKey)).toBe(true);
    expect(decoded.toPubkey.equals(DEST)).toBe(true);
    expect(decoded.lamports).toBe(12_345_678n);
  });

  it('is deterministic: identical inputs produce identical bytes and sig', () => {
    const first = buildSolTransfer(params());
    const second = buildSolTransfer(params());
    if (!first.ok || !second.ok) throw new Error('build failed');
    expect(second.sig).toBe(first.sig);
    expect(second.rawTxB64).toBe(first.rawTxB64);
  });

  it('changes the signature when any input changes', () => {
    const base = buildSolTransfer(params());
    const other = buildSolTransfer(params({ lamports: 12_345_679n }));
    if (!base.ok || !other.ok) throw new Error('build failed');
    expect(other.sig).not.toBe(base.sig);
  });

  it('accepts a base58 destination string', () => {
    const result = buildSolTransfer(params({ to: DEST.toBase58() }));
    expect(result.ok).toBe(true);
  });

  it.each([
    ['zero lamports', params({ lamports: 0n }), /lamports/],
    ['negative lamports', params({ lamports: -1n }), /lamports/],
    ['lamports above u64', params({ lamports: 1n << 64n }), /lamports/],
    [
      'number lamports (not bigint)',
      params({ lamports: 5_000 as unknown as bigint }),
      /lamports/,
    ],
    ['zero lastValidBlockHeight', params({ lastValidBlockHeight: 0 }), /lastValidBlockHeight/],
    [
      'fractional lastValidBlockHeight',
      params({ lastValidBlockHeight: 1.5 }),
      /lastValidBlockHeight/,
    ],
    ['malformed destination', params({ to: 'not-a-pubkey!!' }), /./],
    ['malformed blockhash', params({ recentBlockhash: 'not base58 0OIl' }), /./],
  ])('never throws — %s yields ok:false', (_label, badParams, pattern) => {
    const result = buildSolTransfer(badParams);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(pattern);
  });
});

describe('broadcastRawTx', () => {
  const built = buildSolTransfer(params());
  if (!built.ok) throw new Error(built.error);

  it('sends the exact signed bytes with preflight skipped', async () => {
    const calls: { raw: Buffer; options?: { skipPreflight?: boolean } }[] = [];
    const rpc: BroadcastRpc = {
      async sendRawTransaction(raw, options) {
        calls.push({ raw, options });
        return base58Encode(Transaction.from(raw).signature!);
      },
    };
    const result = await broadcastRawTx(rpc, built.rawTxB64);
    expect(result).toEqual({ ok: true, sig: built.sig, alreadyProcessed: false });
    expect(calls[0]?.options).toEqual({ skipPreflight: true });
    expect(calls[0]?.raw.toString('base64')).toBe(built.rawTxB64);
  });

  it('treats "already processed" as success (deterministic sig landed once)', async () => {
    const rpc: BroadcastRpc = {
      async sendRawTransaction() {
        throw new Error('Transaction simulation failed: This transaction has already been processed');
      },
    };
    const result = await broadcastRawTx(rpc, built.rawTxB64);
    expect(result).toEqual({ ok: true, sig: built.sig, alreadyProcessed: true });
  });

  it('returns ok:false on any other node error, never throwing', async () => {
    const rpc: BroadcastRpc = {
      async sendRawTransaction() {
        throw new Error('Blockhash not found');
      },
    };
    const result = await broadcastRawTx(rpc, built.rawTxB64);
    expect(result).toEqual({ ok: false, error: 'broadcastRawTx: Blockhash not found' });
  });
});

describe('getSigStatus', () => {
  const SIG = base58Encode(new Uint8Array(SIGNATURE_LEN).fill(3));

  type StatusValue = Awaited<ReturnType<SigStatusRpc['getSignatureStatuses']>>['value'][number];

  function statusRpc(value: StatusValue): { rpc: SigStatusRpc; configs: unknown[] } {
    const configs: unknown[] = [];
    const rpc: SigStatusRpc = {
      async getSignatureStatuses(_sigs, config) {
        configs.push(config);
        return { value: [value] };
      },
    };
    return { rpc, configs };
  }

  it('ALWAYS searches full transaction history (double-send guard)', async () => {
    const { rpc, configs } = statusRpc(null);
    await getSigStatus(rpc, SIG);
    expect(configs).toEqual([{ searchTransactionHistory: true }]);
  });

  it('maps a missing status to found:false', async () => {
    const { rpc } = statusRpc(null);
    expect(await getSigStatus(rpc, SIG)).toEqual({ ok: true, found: false });
  });

  it('maps a landed status with its confirmation level and slot', async () => {
    const { rpc } = statusRpc({
      slot: 42,
      confirmations: null,
      err: null,
      confirmationStatus: 'finalized',
    });
    expect(await getSigStatus(rpc, SIG)).toEqual({
      ok: true,
      found: true,
      confirmationStatus: 'finalized',
      slot: 42,
      err: null,
    });
  });

  it('defaults an absent confirmation level to processed', async () => {
    const { rpc } = statusRpc({ slot: 7, confirmations: 1, err: null });
    const result = await getSigStatus(rpc, SIG);
    expect(result).toMatchObject({ ok: true, found: true, confirmationStatus: 'processed' });
  });

  it('stringifies on-chain errors', async () => {
    const { rpc } = statusRpc({
      slot: 9,
      confirmations: null,
      err: { InstructionError: [0, 'Custom'] },
      confirmationStatus: 'confirmed',
    });
    const result = await getSigStatus(rpc, SIG);
    expect(result).toMatchObject({ found: true, err: '{"InstructionError":[0,"Custom"]}' });
  });

  it('returns ok:false on RPC failure, never throwing', async () => {
    const rpc: SigStatusRpc = {
      async getSignatureStatuses() {
        throw new Error('429 Too Many Requests');
      },
    };
    expect(await getSigStatus(rpc, SIG)).toEqual({
      ok: false,
      error: 'getSigStatus: 429 Too Many Requests',
    });
  });
});

describe('isBlockheightExceeded', () => {
  it.each([
    ['below the limit', 99, false],
    ['exactly at the limit (tx can still land)', 100, false],
    ['past the limit', 101, true],
  ])('height %s → exceeded=%s', async (_label, blockHeight, exceeded) => {
    const rpc = { getBlockHeight: async () => blockHeight };
    expect(await isBlockheightExceeded(rpc, 100)).toEqual({ ok: true, exceeded, blockHeight });
  });

  it('checks at finalized commitment by default (conservative expiry)', async () => {
    const commitments: unknown[] = [];
    const rpc = {
      async getBlockHeight(commitment?: 'confirmed' | 'finalized') {
        commitments.push(commitment);
        return 1;
      },
    };
    await isBlockheightExceeded(rpc, 100);
    expect(commitments).toEqual(['finalized']);
  });

  it('returns ok:false on RPC failure, never throwing', async () => {
    const rpc = {
      async getBlockHeight(): Promise<number> {
        throw new Error('socket hang up');
      },
    };
    expect(await isBlockheightExceeded(rpc, 100)).toEqual({
      ok: false,
      error: 'isBlockheightExceeded: socket hang up',
    });
  });
});

describe('resolveResubmitAction (blockhash-expiry decision table)', () => {
  const found = (
    confirmationStatus: 'processed' | 'confirmed' | 'finalized',
    err: string | null = null,
  ): SigStatusKnown => ({ ok: true, found: true, confirmationStatus, slot: 1, err });
  const unknown: SigStatusKnown = { ok: true, found: false };

  it.each([
    ['finalized, not expired', found('finalized'), false, { action: 'confirmed' }],
    ['finalized, expired', found('finalized'), true, { action: 'confirmed' }],
    ['confirmed, not expired', found('confirmed'), false, { action: 'confirmed' }],
    ['confirmed, expired', found('confirmed'), true, { action: 'confirmed' }],
    ['processed, not expired — wait, could still confirm', found('processed'), false, { action: 'wait' }],
    ['processed, expired — wait until dropped or confirmed', found('processed'), true, { action: 'wait' }],
    ['on-chain failure', found('confirmed', '"err"'), false, { action: 'failed', err: '"err"' }],
    ['unknown, not expired — rebroadcast same bytes', unknown, false, { action: 'rebroadcast' }],
    ['unknown, expired — the ONLY safe re-sign case', unknown, true, { action: 'resign' }],
  ])('%s', (_label, status, expired, expected) => {
    expect(resolveResubmitAction(status, expired)).toEqual(expected);
  });
});
