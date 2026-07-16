import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_COMMITMENT,
  fetchIncomingTransfers,
  fetchIncomingTokenTransfers,
  type DepositScanRpc,
  type ParsedTransactionLike,
  type SignatureInfoLike,
} from './deposits.js';
import { isRateLimitError, withRetry } from './rpc.js';
import { ALICE, BOB, MALLORY, TREASURY, fakeSig } from './fixtures/keys.js';
import {
  DOUBLE_DEPOSIT_FIRST_LAMPORTS,
  DOUBLE_DEPOSIT_SECOND_LAMPORTS,
  DOUBLE_DEPOSIT_SIG,
  DOUBLE_DEPOSIT_SLOT,
  DOUBLE_DEPOSIT_TX,
  DUST_LAMPORTS,
  DUST_SIG,
  DUST_SLOT,
  DUST_TX,
  FAILED_SIG,
  FAILED_SLOT,
  MEMO_DEPOSIT_LAMPORTS,
  MEMO_DEPOSIT_SIG,
  MEMO_DEPOSIT_SLOT,
  MEMO_DEPOSIT_TX,
  OPAQUE_IX_LAMPORTS,
  OPAQUE_IX_SIG,
  OPAQUE_IX_SLOT,
  OPAQUE_IX_TX,
  PLAIN_DEPOSIT_LAMPORTS,
  PLAIN_DEPOSIT_SIG,
  PLAIN_DEPOSIT_SLOT,
  PLAIN_DEPOSIT_TX,
  UNSAFE_LAMPORTS_SIG,
  UNSAFE_LAMPORTS_SLOT,
  UNSAFE_LAMPORTS_TX,
  WITHDRAWAL_SIG,
  WITHDRAWAL_SLOT,
  WITHDRAWAL_TX,
  parsedTx,
  sigInfo,
  systemTransferIx,
} from './fixtures/parsed-transfers.js';

/** No real waiting in hermetic tests. */
const instantRetry = { sleep: async () => {}, random: () => 0.5 };

interface SignatureCall {
  before?: string;
  until?: string;
  limit?: number;
  commitment?: string;
}

/**
 * Fixture-backed stand-in for Connection: serves a newest-first signature
 * history with real before/until/limit semantics, and parsed transactions
 * from a sig→fixture map. Records every call for pagination assertions.
 */
class FakeDepositRpc implements DepositScanRpc {
  readonly signatureCalls: SignatureCall[] = [];
  readonly parseCalls: { sigs: string[]; config?: unknown }[] = [];

  constructor(
    private readonly history: SignatureInfoLike[], // newest-first
    private readonly txBySig: ReadonlyMap<string, ParsedTransactionLike | null>,
  ) {}

  async getSignaturesForAddress(
    _address: unknown,
    options?: { before?: string; until?: string; limit?: number },
    commitment?: 'finalized',
  ): Promise<SignatureInfoLike[]> {
    const { before, until, limit = 1_000 } = options ?? {};
    this.signatureCalls.push({ before, until, limit, commitment });
    let window = this.history;
    if (before !== undefined) {
      const i = window.findIndex((info) => info.signature === before);
      window = i >= 0 ? window.slice(i + 1) : window;
    }
    if (until !== undefined) {
      const i = window.findIndex((info) => info.signature === until);
      if (i >= 0) window = window.slice(0, i);
    }
    return window.slice(0, limit);
  }

  async getParsedTransactions(
    sigs: string[],
    config?: { commitment?: 'finalized'; maxSupportedTransactionVersion?: number },
  ): Promise<(ParsedTransactionLike | null)[]> {
    this.parseCalls.push({ sigs, config });
    return sigs.map((sig) => this.txBySig.get(sig) ?? null);
  }
}

function rpcFor(entries: [SignatureInfoLike, ParsedTransactionLike | null][]): FakeDepositRpc {
  return new FakeDepositRpc(
    entries.map(([info]) => info),
    new Map(entries.map(([info, tx]) => [info.signature, tx])),
  );
}

function okTransfers(result: Awaited<ReturnType<typeof fetchIncomingTransfers>>) {
  if (!result.ok) throw new Error(result.error);
  return result.transfers;
}

describe('fetchIncomingTransfers — extraction', () => {
  it('extracts a plain Phantom-style send', async () => {
    const rpc = rpcFor([[sigInfo(PLAIN_DEPOSIT_SIG, PLAIN_DEPOSIT_SLOT), PLAIN_DEPOSIT_TX]]);
    const transfers = okTransfers(await fetchIncomingTransfers(rpc, TREASURY, { retry: instantRetry }));
    expect(transfers).toEqual([
      {
        sig: PLAIN_DEPOSIT_SIG,
        ixIndex: 0,
        sender: ALICE,
        lamports: BigInt(PLAIN_DEPOSIT_LAMPORTS),
        slot: PLAIN_DEPOSIT_SLOT,
      },
    ]);
  });

  it('requests finalized parsed transactions with version support', async () => {
    const rpc = rpcFor([[sigInfo(PLAIN_DEPOSIT_SIG, PLAIN_DEPOSIT_SLOT), PLAIN_DEPOSIT_TX]]);
    await fetchIncomingTransfers(rpc, TREASURY, { retry: instantRetry });
    expect(rpc.parseCalls).toEqual([
      {
        sigs: [PLAIN_DEPOSIT_SIG],
        config: { commitment: DEPOSIT_COMMITMENT, maxSupportedTransactionVersion: 0 },
      },
    ]);
    expect(rpc.signatureCalls[0]?.commitment).toBe(DEPOSIT_COMMITMENT);
  });

  it('emits BOTH transfers of a batched tx with distinct ixIndex', async () => {
    const rpc = rpcFor([[sigInfo(DOUBLE_DEPOSIT_SIG, DOUBLE_DEPOSIT_SLOT), DOUBLE_DEPOSIT_TX]]);
    const transfers = okTransfers(await fetchIncomingTransfers(rpc, TREASURY, { retry: instantRetry }));
    expect(transfers).toEqual([
      {
        sig: DOUBLE_DEPOSIT_SIG,
        ixIndex: 0,
        sender: ALICE,
        lamports: BigInt(DOUBLE_DEPOSIT_FIRST_LAMPORTS),
        slot: DOUBLE_DEPOSIT_SLOT,
      },
      {
        sig: DOUBLE_DEPOSIT_SIG,
        ixIndex: 2,
        sender: ALICE,
        lamports: BigInt(DOUBLE_DEPOSIT_SECOND_LAMPORTS),
        slot: DOUBLE_DEPOSIT_SLOT,
      },
    ]);
  });

  it('ignores withdrawals and self-transfers (treasury as source)', async () => {
    const rpc = rpcFor([[sigInfo(WITHDRAWAL_SIG, WITHDRAWAL_SLOT), WITHDRAWAL_TX]]);
    const transfers = okTransfers(await fetchIncomingTransfers(rpc, TREASURY, { retry: instantRetry }));
    expect(transfers).toEqual([]);
  });

  it('emits dust by default (engine stores sub-minimum rows as uncredited)', async () => {
    const rpc = rpcFor([[sigInfo(DUST_SIG, DUST_SLOT), DUST_TX]]);
    const transfers = okTransfers(await fetchIncomingTransfers(rpc, TREASURY, { retry: instantRetry }));
    expect(transfers).toEqual([
      { sig: DUST_SIG, ixIndex: 0, sender: MALLORY, lamports: BigInt(DUST_LAMPORTS), slot: DUST_SLOT },
    ]);
  });

  it('drops transfers below minLamports when a threshold is given', async () => {
    const rpc = rpcFor([
      [sigInfo(PLAIN_DEPOSIT_SIG, PLAIN_DEPOSIT_SLOT), PLAIN_DEPOSIT_TX],
      [sigInfo(DUST_SIG, DUST_SLOT), DUST_TX],
    ]);
    const transfers = okTransfers(
      await fetchIncomingTransfers(rpc, TREASURY, { minLamports: 1_000_000n, retry: instantRetry }),
    );
    expect(transfers.map((t) => t.sig)).toEqual([PLAIN_DEPOSIT_SIG]);
  });

  it('tolerates a memo instruction and still extracts the transfer', async () => {
    const rpc = rpcFor([[sigInfo(MEMO_DEPOSIT_SIG, MEMO_DEPOSIT_SLOT), MEMO_DEPOSIT_TX]]);
    const transfers = okTransfers(await fetchIncomingTransfers(rpc, TREASURY, { retry: instantRetry }));
    expect(transfers).toEqual([
      {
        sig: MEMO_DEPOSIT_SIG,
        ixIndex: 1,
        sender: BOB,
        lamports: BigInt(MEMO_DEPOSIT_LAMPORTS),
        slot: MEMO_DEPOSIT_SLOT,
      },
    ]);
  });

  it('tolerates partially-decoded instructions alongside a transfer', async () => {
    const rpc = rpcFor([[sigInfo(OPAQUE_IX_SIG, OPAQUE_IX_SLOT), OPAQUE_IX_TX]]);
    const transfers = okTransfers(await fetchIncomingTransfers(rpc, TREASURY, { retry: instantRetry }));
    expect(transfers).toEqual([
      {
        sig: OPAQUE_IX_SIG,
        ixIndex: 1,
        sender: ALICE,
        lamports: BigInt(OPAQUE_IX_LAMPORTS),
        slot: OPAQUE_IX_SLOT,
      },
    ]);
  });

  it('skips failed signatures without fetching them', async () => {
    const rpc = rpcFor([
      [sigInfo(FAILED_SIG, FAILED_SLOT, { InstructionError: [0, 'Custom'] }), null],
      [sigInfo(PLAIN_DEPOSIT_SIG, PLAIN_DEPOSIT_SLOT), PLAIN_DEPOSIT_TX],
    ]);
    const transfers = okTransfers(await fetchIncomingTransfers(rpc, TREASURY, { retry: instantRetry }));
    expect(transfers.map((t) => t.sig)).toEqual([PLAIN_DEPOSIT_SIG]);
    expect(rpc.parseCalls.flatMap((c) => c.sigs)).toEqual([PLAIN_DEPOSIT_SIG]);
  });

  it('skips a tx whose meta.err is set even when the signature list missed it', async () => {
    const failedTx = parsedTx(FAILED_SIG, FAILED_SLOT, [systemTransferIx(ALICE, TREASURY, 1_000_000)], {
      InstructionError: [0, 'Custom'],
    });
    const rpc = rpcFor([[sigInfo(FAILED_SIG, FAILED_SLOT), failedTx]]);
    const transfers = okTransfers(await fetchIncomingTransfers(rpc, TREASURY, { retry: instantRetry }));
    expect(transfers).toEqual([]);
  });

  it('fails the whole scan when a finalized signature cannot be parsed', async () => {
    const rpc = rpcFor([[sigInfo(PLAIN_DEPOSIT_SIG, PLAIN_DEPOSIT_SLOT), null]]);
    const result = await fetchIncomingTransfers(rpc, TREASURY, { retry: instantRetry });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(PLAIN_DEPOSIT_SIG);
  });

  it('fails loud on lamports beyond Number.MAX_SAFE_INTEGER', async () => {
    const rpc = rpcFor([[sigInfo(UNSAFE_LAMPORTS_SIG, UNSAFE_LAMPORTS_SLOT), UNSAFE_LAMPORTS_TX]]);
    const result = await fetchIncomingTransfers(rpc, TREASURY, { retry: instantRetry });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unsafe lamports/);
  });

  it('rejects a malformed treasury pubkey without throwing', async () => {
    const rpc = rpcFor([]);
    const result = await fetchIncomingTransfers(rpc, 'definitely-not-base58!!', { retry: instantRetry });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid treasury pubkey/);
  });
});

describe('fetchIncomingTokenTransfers — USDC extraction', () => {
  it('extracts checked transfers into the treasury ATA using the authority as owner', async () => {
    const sig = fakeSig(210);
    const tx = parsedTx(sig, 9_100, [{
      program: 'spl-token',
      parsed: {
        type: 'transferChecked',
        info: {
          source: BOB,
          destination: TREASURY,
          authority: ALICE,
          mint: MALLORY,
          tokenAmount: { amount: '5000001', decimals: 6 },
        },
      },
    }]);
    const rpc = rpcFor([[sigInfo(sig, 9_100), tx]]);
    const result = await fetchIncomingTokenTransfers(rpc, TREASURY, MALLORY, {
      retry: instantRetry,
    });
    expect(result).toMatchObject({
      ok: true,
      transfers: [{ sig, ixIndex: 0, sender: ALICE, lamports: 5_000_001n, slot: 9_100 }],
    });
  });

  it('accepts plain transfers to the mint-specific ATA and ignores wrong mints', async () => {
    const plainSig = fakeSig(211);
    const wrongMintSig = fakeSig(212);
    const plain = parsedTx(plainSig, 9_101, [{
      program: 'spl-token',
      parsed: {
        type: 'transfer',
        info: { source: BOB, destination: TREASURY, authority: ALICE, amount: '1000000' },
      },
    }]);
    const wrongMint = parsedTx(wrongMintSig, 9_102, [{
      program: 'spl-token',
      parsed: {
        type: 'transferChecked',
        info: {
          source: BOB,
          destination: TREASURY,
          authority: ALICE,
          mint: BOB,
          tokenAmount: { amount: '9000000', decimals: 6 },
        },
      },
    }]);
    const rpc = rpcFor([
      [sigInfo(wrongMintSig, 9_102), wrongMint],
      [sigInfo(plainSig, 9_101), plain],
    ]);
    const result = await fetchIncomingTokenTransfers(rpc, TREASURY, MALLORY, {
      retry: instantRetry,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.transfers.map((entry) => entry.sig)).toEqual([plainSig]);
  });

  it('fails without advancing past a malformed token amount', async () => {
    const sig = fakeSig(213);
    const tx = parsedTx(sig, 9_103, [{
      program: 'spl-token',
      parsed: {
        type: 'transfer',
        info: { source: BOB, destination: TREASURY, authority: ALICE, amount: 1_000_000 },
      },
    }]);
    const result = await fetchIncomingTokenTransfers(
      rpcFor([[sigInfo(sig, 9_103), tx]]),
      TREASURY,
      MALLORY,
      { retry: instantRetry },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unsafe token amount');
  });
});

describe('fetchIncomingTransfers — pagination (dust-spam window defense)', () => {
  // Five deposits, oldest→newest B..F, behind a cursor at A. Page size 2
  // forces three backward hops before the node reports cursor coverage.
  const CURSOR_SIG = fakeSig(100);
  const deposits = [101, 102, 103, 104, 105].map((label, i) => {
    const sig = fakeSig(label);
    const slot = 2_000 + i;
    const lamports = 1_000_000 * (i + 1);
    return { sig, slot, tx: parsedTx(sig, slot, [systemTransferIx(ALICE, TREASURY, lamports)]) };
  });
  const newestFirst = [...deposits].reverse();

  function paginatedRpc(): FakeDepositRpc {
    return new FakeDepositRpc(
      [...newestFirst.map((d) => sigInfo(d.sig, d.slot)), sigInfo(CURSOR_SIG, 1_999)],
      new Map(deposits.map((d) => [d.sig, d.tx])),
    );
  }

  it('pages backwards with before until the cursor is reached', async () => {
    const rpc = paginatedRpc();
    const result = await fetchIncomingTransfers(rpc, TREASURY, {
      untilSig: CURSOR_SIG,
      pageLimit: 2,
      retry: instantRetry,
    });
    if (!result.ok) throw new Error(result.error);

    // 2 + 2 + 1 signatures: the short final page is the stop condition.
    expect(rpc.signatureCalls).toEqual([
      { before: undefined, until: CURSOR_SIG, limit: 2, commitment: DEPOSIT_COMMITMENT },
      { before: newestFirst[1]!.sig, until: CURSOR_SIG, limit: 2, commitment: DEPOSIT_COMMITMENT },
      { before: newestFirst[3]!.sig, until: CURSOR_SIG, limit: 2, commitment: DEPOSIT_COMMITMENT },
    ]);
    // All five deposits recovered despite the tiny window, oldest-first.
    expect(result.transfers.map((t) => t.sig)).toEqual(deposits.map((d) => d.sig));
    expect(result.transfers.map((t) => t.lamports)).toEqual([
      1_000_000n,
      2_000_000n,
      3_000_000n,
      4_000_000n,
      5_000_000n,
    ]);
    expect(result.newestSig).toBe(newestFirst[0]!.sig);
    expect(result.scannedSigs).toBe(5);
  });

  it('batches getParsedTransactions requests', async () => {
    const rpc = paginatedRpc();
    await fetchIncomingTransfers(rpc, TREASURY, {
      untilSig: CURSOR_SIG,
      pageLimit: 2,
      batchSize: 2,
      retry: instantRetry,
    });
    expect(rpc.parseCalls.map((c) => c.sigs.length)).toEqual([2, 2, 1]);
  });

  it('never emits the cursor signature itself', async () => {
    const rpc = new FakeDepositRpc(
      [sigInfo(PLAIN_DEPOSIT_SIG, PLAIN_DEPOSIT_SLOT), sigInfo(CURSOR_SIG, 1_999)],
      new Map([[PLAIN_DEPOSIT_SIG, PLAIN_DEPOSIT_TX]]),
    );
    const transfers = okTransfers(
      await fetchIncomingTransfers(rpc, TREASURY, { untilSig: CURSOR_SIG, retry: instantRetry }),
    );
    expect(transfers.map((t) => t.sig)).toEqual([PLAIN_DEPOSIT_SIG]);
  });

  it('aborts (ok:false) instead of looping forever on a bottomless history', async () => {
    const bottomless: DepositScanRpc = {
      async getSignaturesForAddress(_address, options) {
        const limit = options?.limit ?? 1_000;
        // Always a full page of fresh signatures — cursor never found.
        return Array.from({ length: limit }, (_, i) =>
          sigInfo(fakeSig(Math.floor(Math.random() * 1_000_000) + i), 3_000),
        );
      },
      async getParsedTransactions(sigs) {
        return sigs.map(() => null);
      },
    };
    const result = await fetchIncomingTransfers(bottomless, TREASURY, {
      untilSig: CURSOR_SIG,
      pageLimit: 2,
      retry: instantRetry,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/aborted after/);
  });
});

describe('fetchIncomingTransfers — retry/backoff', () => {
  it('rides out transient 429s on the signature walk', async () => {
    const inner = rpcFor([[sigInfo(PLAIN_DEPOSIT_SIG, PLAIN_DEPOSIT_SLOT), PLAIN_DEPOSIT_TX]]);
    let failures = 2;
    const flaky: DepositScanRpc = {
      async getSignaturesForAddress(address, options, commitment) {
        if (failures > 0) {
          failures -= 1;
          throw new Error('429 Too Many Requests: rate limit hit');
        }
        return inner.getSignaturesForAddress(address, options, commitment);
      },
      getParsedTransactions: inner.getParsedTransactions.bind(inner),
    };
    const sleeps: number[] = [];
    const result = await fetchIncomingTransfers(flaky, TREASURY, {
      retry: {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.5,
      },
    });
    expect(okTransfers(result)).toHaveLength(1);
    // 429s always back off at least 2s regardless of the exponential base.
    expect(sleeps).toEqual([2_000, 2_000]);
  });

  it('surfaces exhaustion as ok:false, never throwing', async () => {
    const dead: DepositScanRpc = {
      async getSignaturesForAddress() {
        throw new Error('429 Too Many Requests');
      },
      async getParsedTransactions() {
        return [];
      },
    };
    const sleeps: number[] = [];
    const result = await fetchIncomingTransfers(dead, TREASURY, {
      retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 },
    });
    expect(result).toEqual({
      ok: false,
      error: 'fetchIncomingTransfers: 429 Too Many Requests',
    });
    expect(sleeps).toHaveLength(3); // 4 attempts → 3 waits
  });
});

describe('withRetry', () => {
  it('returns immediately on success without sleeping', async () => {
    const sleeps: number[] = [];
    const value = await withRetry(async () => 'ok', {
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(value).toBe('ok');
    expect(sleeps).toEqual([]);
  });

  it('backs off exponentially with jitter on generic failures', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 4) throw new Error('fetch failed');
        return calls;
      },
      { sleep: async (ms) => void sleeps.push(ms), random: () => 0 }, // jitter floor 0.5x
    );
    expect(value).toBe(4);
    expect(sleeps).toEqual([200, 400, 800]); // 400/800/1600 × 0.5
  });

  it('caps the delay at maxDelayMs before applying the 429 floor', async () => {
    const sleeps: number[] = [];
    await expect(
      withRetry(
        async () => {
          throw new Error('gateway timeout');
        },
        {
          attempts: 3,
          baseDelayMs: 10_000,
          maxDelayMs: 5_000,
          sleep: async (ms) => void sleeps.push(ms),
          random: () => 0.5, // jitter factor exactly 1.0
        },
      ),
    ).rejects.toThrow('gateway timeout');
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it('reports retries with the rate-limited flag', async () => {
    const events: { attempt: number; rateLimited: boolean }[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('429 Too Many Requests');
        return calls;
      },
      {
        sleep: async () => {},
        random: () => 0.5,
        onRetry: ({ attempt, rateLimited }) => void events.push({ attempt, rateLimited }),
      },
    );
    expect(events).toEqual([{ attempt: 1, rateLimited: true }]);
  });

  it('makes exactly `attempts` calls before rethrowing the last error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`boom ${calls}`);
        },
        { sleep: async () => {}, random: () => 0.5 },
      ),
    ).rejects.toThrow('boom 4');
    expect(calls).toBe(4);
  });
});

describe('isRateLimitError', () => {
  it.each([
    ['message with status line', new Error('429 Too Many Requests'), true],
    ['message with phrase only', new Error('Server responded with Too Many Requests'), true],
    ['numeric status field', Object.assign(new Error('rate limited'), { statusCode: 429 }), true],
    ['numeric status property', { status: 429 }, true],
    ['unrelated error', new Error('Blockhash not found'), false],
    ['non-error value', 'flaky socket', false],
  ])('%s → %s', (_label, error, expected) => {
    expect(isRateLimitError(error)).toBe(expected);
  });
});
