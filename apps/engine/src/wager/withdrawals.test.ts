import { describe, expect, it } from 'vitest';
import { createWithdrawalExecutor } from './withdrawals.js';
import { WAGER_KEYS } from './constants.js';
import { makeFakeDeps, type FakeDepsBundle } from './fakes.js';
import type { WagerWithdrawalRow } from './port.js';

const USER = 42;
const GROUP = -100;
const DEST = 'DestPubkey111111111111111111111111111111111';

/** A funded user with one queued (debited) withdrawal of 0.05 SOL. */
async function bundleWithDebitedRow(): Promise<FakeDepsBundle & { row: WagerWithdrawalRow }> {
  const bundle = makeFakeDeps();
  bundle.db.seedLink(USER, DEST, GROUP);
  bundle.db.users.set(USER, 'Riko');
  bundle.db.seedBalance(USER, 1_000_000_000n);
  const result = await bundle.db.requestWithdrawal({ user_id: USER, lamports: 50_000_000n });
  if (!result.ok) throw new Error('fixture: withdrawal refused');
  const row = bundle.db.withdrawals.get(result.withdrawal_id);
  if (!row) throw new Error('fixture: row missing');
  return { ...bundle, row };
}

describe('withdrawal executor — happy path', () => {
  it('signs, persists BEFORE broadcasting, then confirms and posts a receipt', async () => {
    const bundle = await bundleWithDebitedRow();
    const executor = createWithdrawalExecutor(bundle.deps);

    await executor.tick();
    expect(bundle.row.state).toBe('submitted');
    expect(bundle.row.tx_sig).toBe('sig-1');
    expect(bundle.row.raw_tx_b64).toBe('raw-1');
    expect(bundle.row.last_valid_block_height).toBe(101);
    // The money invariant: the signed bytes hit the DB before the network.
    const persistIndex = bundle.trace.indexOf('db.markWithdrawalSubmitted:sig-1');
    const broadcastIndex = bundle.trace.indexOf('chain.broadcastRawTx:raw-1');
    expect(persistIndex).toBeGreaterThanOrEqual(0);
    expect(broadcastIndex).toBeGreaterThan(persistIndex);

    bundle.chain.sigStatuses.set('sig-1', {
      ok: true,
      found: true,
      confirmationStatus: 'confirmed',
      err: null,
    });
    await executor.tick();
    expect(bundle.row.state).toBe('confirmed');
    expect(bundle.poster.posts).toHaveLength(1);
    expect(bundle.poster.posts[0]?.chatId).toBe(USER);
    expect(bundle.poster.posts[0]?.text).toContain('sig-1'); // explorer link
    expect(bundle.db.ledgerByKey(WAGER_KEYS.withdrawalRefund(bundle.row.id))).toBeUndefined();
  });
});

describe('withdrawal executor — crash-at-every-arrow table', () => {
  interface Arrow {
    name: string;
    /** Shape the persisted world as the crash left it. */
    arrange: (bundle: FakeDepsBundle & { row: WagerWithdrawalRow }) => void;
    /** What one recovery tick must (and must not) do. */
    assert: (bundle: FakeDepsBundle & { row: WagerWithdrawalRow }) => void;
  }

  const arrows: Arrow[] = [
    {
      name: 'crashed after the RPC debit, before any signing → row is retried whole',
      arrange: () => undefined, // pristine debited row
      assert: (b) => {
        expect(b.row.state).toBe('submitted');
        expect(b.chain.broadcasts).toEqual(['raw-1']);
      },
    },
    {
      name: 'crashed between persist and broadcast → identical bytes rebroadcast, same sig',
      arrange: (b) => {
        // Simulate: submitted row on disk, nothing ever hit the network.
        b.row.state = 'submitted';
        b.row.tx_sig = 'sig-old';
        b.row.raw_tx_b64 = 'raw-old';
        b.row.last_valid_block_height = 90;
        // status: never landed, blockhash still valid
        b.chain.blockheightExceeded = false;
      },
      assert: (b) => {
        expect(b.chain.broadcasts).toEqual(['raw-old']); // the SAME bytes
        expect(b.row.tx_sig).toBe('sig-old'); // never re-signed
        expect(b.row.state).toBe('submitted');
      },
    },
    {
      name: 'submitted + status unknown + blockhash expired → re-sign fresh, persist first',
      arrange: (b) => {
        b.row.state = 'submitted';
        b.row.tx_sig = 'sig-old';
        b.row.raw_tx_b64 = 'raw-old';
        b.row.last_valid_block_height = 90;
        b.chain.blockheightExceeded = true;
      },
      assert: (b) => {
        expect(b.row.tx_sig).toBe('sig-1'); // fresh signature on the SAME row
        expect(b.chain.broadcasts).toEqual(['raw-1']); // old bytes never resent
        const persistIndex = b.trace.indexOf('db.markWithdrawalSubmitted:sig-1');
        const broadcastIndex = b.trace.indexOf('chain.broadcastRawTx:raw-1');
        expect(persistIndex).toBeGreaterThanOrEqual(0);
        expect(broadcastIndex).toBeGreaterThan(persistIndex);
      },
    },
    {
      name: 'confirmed long ago + blockhash expired → confirm wins, NEVER re-sign',
      arrange: (b) => {
        b.row.state = 'submitted';
        b.row.tx_sig = 'sig-old';
        b.row.raw_tx_b64 = 'raw-old';
        b.row.last_valid_block_height = 90;
        b.chain.blockheightExceeded = true; // would tempt a re-sign…
        b.chain.sigStatuses.set('sig-old', {
          ok: true,
          found: true,
          confirmationStatus: 'finalized',
          err: null,
        }); // …but full-history status says it landed
      },
      assert: (b) => {
        expect(b.row.state).toBe('confirmed');
        expect(b.chain.broadcasts).toHaveLength(0);
        expect(b.row.tx_sig).toBe('sig-old');
        expect(b.db.ledgerByKey(WAGER_KEYS.withdrawalRefund(b.row.id))).toBeUndefined();
      },
    },
    {
      name: 'status "processed" → wait: no rebroadcast decision, no re-sign, no refund',
      arrange: (b) => {
        b.row.state = 'submitted';
        b.row.tx_sig = 'sig-old';
        b.row.raw_tx_b64 = 'raw-old';
        b.row.last_valid_block_height = 90;
        b.chain.blockheightExceeded = true;
        b.chain.sigStatuses.set('sig-old', {
          ok: true,
          found: true,
          confirmationStatus: 'processed',
          err: null,
        });
      },
      assert: (b) => {
        expect(b.row.state).toBe('submitted');
        expect(b.row.tx_sig).toBe('sig-old');
        expect(b.chain.broadcasts).toHaveLength(0);
      },
    },
    {
      name: 'status RPC failure → take no action at all',
      arrange: (b) => {
        b.row.state = 'submitted';
        b.row.tx_sig = 'sig-old';
        b.row.raw_tx_b64 = 'raw-old';
        b.row.last_valid_block_height = 90;
        b.chain.blockheightExceeded = true;
        b.chain.sigStatuses.set('sig-old', { ok: false, error: '429' });
      },
      assert: (b) => {
        expect(b.row.state).toBe('submitted');
        expect(b.chain.broadcasts).toHaveLength(0);
        expect(b.row.tx_sig).toBe('sig-old');
      },
    },
    {
      name: 'expiry-check RPC failure → no re-sign on ignorance',
      arrange: (b) => {
        b.row.state = 'submitted';
        b.row.tx_sig = 'sig-old';
        b.row.raw_tx_b64 = 'raw-old';
        b.row.last_valid_block_height = 90;
        b.chain.isBlockheightExceeded = async () => ({ ok: false, error: 'rpc down' });
      },
      assert: (b) => {
        expect(b.row.state).toBe('submitted');
        expect(b.row.tx_sig).toBe('sig-old');
        expect(b.chain.broadcasts).toHaveLength(0);
      },
    },
    {
      name: 'tx landed with an on-chain error → refund credit BEFORE the failed flip',
      arrange: (b) => {
        b.row.state = 'submitted';
        b.row.tx_sig = 'sig-old';
        b.row.raw_tx_b64 = 'raw-old';
        b.row.last_valid_block_height = 90;
        b.chain.sigStatuses.set('sig-old', {
          ok: true,
          found: true,
          confirmationStatus: 'finalized',
          err: '{"InstructionError":[0,"Custom"]}',
        });
      },
      assert: (b) => {
        expect(b.row.state).toBe('failed');
        const refundKey = WAGER_KEYS.withdrawalRefund(b.row.id);
        expect(b.db.ledgerByKey(refundKey)?.lamports).toBe(50_000_000n);
        const refundIndex = b.trace.indexOf(`db.postWagerLedger:${refundKey}`);
        const failIndex = b.trace.indexOf(`db.markWithdrawalFailed:${b.row.id}`);
        expect(refundIndex).toBeGreaterThanOrEqual(0);
        expect(failIndex).toBeGreaterThan(refundIndex);
        expect(b.poster.posts).toHaveLength(1); // private failure note
        expect(b.poster.posts[0]?.chatId).toBe(USER);
      },
    },
    {
      name: 'permanent build failure → refund + failed without ever broadcasting',
      arrange: (b) => {
        b.chain.buildFails = { error: 'bad dest', permanent: true };
      },
      assert: (b) => {
        expect(b.row.state).toBe('failed');
        expect(b.db.ledgerByKey(WAGER_KEYS.withdrawalRefund(b.row.id))?.lamports).toBe(
          50_000_000n,
        );
        expect(b.chain.broadcasts).toHaveLength(0);
      },
    },
    {
      name: 'transient build failure → row stays debited for the next tick',
      arrange: (b) => {
        b.chain.buildFails = { error: 'blockhash fetch failed' };
      },
      assert: (b) => {
        expect(b.row.state).toBe('debited');
        expect(b.db.ledgerByKey(WAGER_KEYS.withdrawalRefund(b.row.id))).toBeUndefined();
        expect(b.chain.broadcasts).toHaveLength(0);
      },
    },
    {
      name: 'broadcast failure after persist → still submitted with its sig on file',
      arrange: (b) => {
        b.chain.broadcastFails = true;
      },
      assert: (b) => {
        expect(b.row.state).toBe('submitted');
        expect(b.row.tx_sig).toBe('sig-1');
        expect(b.db.ledgerByKey(WAGER_KEYS.withdrawalRefund(b.row.id))).toBeUndefined();
      },
    },
  ];

  it.each(arrows.map((arrow) => [arrow.name, arrow] as const))('%s', async (_name, arrow) => {
    const bundle = await bundleWithDebitedRow();
    arrow.arrange(bundle);
    await createWithdrawalExecutor(bundle.deps).tick();
    arrow.assert(bundle);
  });

  it('a failed row is terminal — the refund never doubles on later ticks', async () => {
    const bundle = await bundleWithDebitedRow();
    bundle.row.state = 'submitted';
    bundle.row.tx_sig = 'sig-old';
    bundle.row.raw_tx_b64 = 'raw-old';
    bundle.row.last_valid_block_height = 90;
    bundle.chain.sigStatuses.set('sig-old', {
      ok: true,
      found: true,
      confirmationStatus: 'finalized',
      err: 'boom',
    });
    const executor = createWithdrawalExecutor(bundle.deps);
    await executor.tick();
    await executor.tick();
    const refunds = bundle.db.ledger.filter((entry) => entry.kind === 'withdrawal_refund');
    expect(refunds).toHaveLength(1);
  });

  it('crash between refund and failed-flip converges without double credit', async () => {
    const bundle = await bundleWithDebitedRow();
    bundle.row.state = 'submitted';
    bundle.row.tx_sig = 'sig-old';
    bundle.row.raw_tx_b64 = 'raw-old';
    bundle.row.last_valid_block_height = 90;
    bundle.chain.sigStatuses.set('sig-old', {
      ok: true,
      found: true,
      confirmationStatus: 'finalized',
      err: 'boom',
    });
    // Simulate the crash: the refund landed but the state flip did not.
    await bundle.db.postWagerLedger({
      user_id: USER,
      group_id: null,
      market_id: null,
      kind: 'withdrawal_refund',
      lamports: 50_000_000n,
      idempotency_key: WAGER_KEYS.withdrawalRefund(bundle.row.id),
    });
    await createWithdrawalExecutor(bundle.deps).tick();
    expect(bundle.row.state).toBe('failed');
    const refunds = bundle.db.ledger.filter((entry) => entry.kind === 'withdrawal_refund');
    expect(refunds).toHaveLength(1); // the idempotency key absorbed the rerun
  });

  it('does nothing when the cron singleton lock is held elsewhere', async () => {
    const bundle = await bundleWithDebitedRow();
    bundle.db.cronLockGranted = false;
    await createWithdrawalExecutor(bundle.deps).tick();
    expect(bundle.row.state).toBe('debited');
    expect(bundle.chain.broadcasts).toHaveLength(0);
  });
});
