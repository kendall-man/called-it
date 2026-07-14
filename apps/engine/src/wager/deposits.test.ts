import { describe, expect, it } from 'vitest';
import { classifyOrphanDepositsForOps, createDepositWatcher } from './deposits.js';
import { depositCursorStream, WAGER_KEYS, WAGER_TUNABLES } from './constants.js';
import { makeFakeDeps } from './fakes.js';
import type { WagerIncomingTransfer } from './port.js';

const SENDER = 'SenderPubkey11111111111111111111111111111111';
const GROUP = -200;
const USER = 7;

function transfer(overrides: Partial<WagerIncomingTransfer>): WagerIncomingTransfer {
  return {
    asset: overrides.asset ?? 'sol',
    mintPubkey: overrides.mintPubkey ?? null,
    sig: overrides.sig ?? 'sigA',
    ixIndex: overrides.ixIndex ?? 0,
    sender: overrides.sender ?? SENDER,
    lamports: overrides.lamports ?? 5_000_000n,
    slot: overrides.slot ?? 10,
  };
}

describe('deposit watcher', () => {
  it('logs a credited deposit without Telegram user identity', async () => {
    // Given a linked Telegram user and a collectable structured logger
    const infoEvents: Array<{
      readonly event: string;
      readonly fields: Record<string, unknown> | undefined;
    }> = [];
    const { deps, db, chain } = makeFakeDeps({
      log: {
        info(event, fields) {
          infoEvents.push({ event, fields });
        },
        warn: () => undefined,
        error: () => undefined,
      },
    });
    db.seedLink(USER, SENDER, GROUP);
    chain.setScanTransfers([transfer({ sig: 'privacy-sig', lamports: 5_000_000n })]);

    // When the watcher credits the deposit
    await createDepositWatcher(deps).tick();

    // Then the credit log retains domain diagnostics without Telegram identity
    expect(infoEvents.find(({ event }) => event === 'wager_deposit_credited')?.fields).toEqual({
      txSig: 'privacy-sig',
      ixIndex: 0,
      lamports: '5000000',
    });
  });

  it('credits a linked sender at/above the minimum and notifies the user privately', async () => {
    const { deps, db, chain, poster } = makeFakeDeps();
    db.seedLink(USER, SENDER, GROUP);
    db.users.set(USER, 'Mika');
    chain.setScanTransfers([transfer({ sig: 'sigA', lamports: 5_000_000n })]);

    await createDepositWatcher(deps).tick();

    expect(db.ledgerByKey(WAGER_KEYS.deposit('sigA', 0))?.lamports).toBe(5_000_000n);
    expect(db.deposits.get('sigA:0')?.credited_at).not.toBeNull();
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0]?.chatId).toBe(USER);
    expect(poster.posts[0]?.text).toContain('Mika');
    expect(db.cursors.get(depositCursorStream(chain.treasuryPubkey()))).toBe('sigA');
  });

  it('credits every transfer of a multi-transfer transaction under distinct keys', async () => {
    const { deps, db, chain } = makeFakeDeps();
    db.seedLink(USER, SENDER, GROUP);
    chain.setScanTransfers([
      transfer({ sig: 'sigA', ixIndex: 0, lamports: 2_000_000n }),
      transfer({ sig: 'sigA', ixIndex: 1, lamports: 3_000_000n }),
    ]);

    await createDepositWatcher(deps).tick();

    expect(db.ledgerByKey(WAGER_KEYS.deposit('sigA', 0))?.lamports).toBe(2_000_000n);
    expect(db.ledgerByKey(WAGER_KEYS.deposit('sigA', 1))?.lamports).toBe(3_000_000n);
    expect(await db.balanceLamports(USER)).toBe(5_000_000n);
  });

  it('stores an unlinked sender as an orphan row — no credit, no chat', async () => {
    const { deps, db, chain, poster } = makeFakeDeps();
    chain.setScanTransfers([transfer({ sig: 'sigB' })]);

    await createDepositWatcher(deps).tick();

    const row = db.deposits.get('sigB:0');
    expect(row?.user_id).toBeNull();
    expect(row?.credited_at).toBeNull();
    expect(db.ledger).toHaveLength(0);
    expect(poster.posts).toHaveLength(0);
  });

  it('stores sub-minimum dust without crediting it', async () => {
    const { deps, db, chain } = makeFakeDeps();
    db.seedLink(USER, SENDER, GROUP);
    chain.setScanTransfers([
      transfer({ sig: 'sigC', lamports: WAGER_TUNABLES.MIN_DEPOSIT_LAMPORTS - 1n }),
    ]);

    await createDepositWatcher(deps).tick();

    expect(db.deposits.has('sigC:0')).toBe(true);
    expect(db.ledger).toHaveLength(0);
  });

  it('re-processing the same scan is idempotent — no double credit, no double notify', async () => {
    const { deps, db, chain, poster } = makeFakeDeps();
    db.seedLink(USER, SENDER, GROUP);
    db.users.set(USER, 'Mika');
    chain.setScanTransfers([transfer({ sig: 'sigA' })]);

    const watcher = createDepositWatcher(deps);
    await watcher.tick();
    await watcher.tick(); // cursor is advanced, but simulate a full re-scan anyway
    expect(db.ledger).toHaveLength(1);
    expect(poster.posts).toHaveLength(1);
  });

  it('notifies a linked user privately even before their first group position', async () => {
    const { deps, db, chain, poster } = makeFakeDeps();
    db.seedLink(USER, SENDER, null); // linked but never wagered in a group
    chain.setScanTransfers([transfer({ sig: 'sigA' })]);

    await createDepositWatcher(deps).tick();

    expect(db.ledgerByKey(WAGER_KEYS.deposit('sigA', 0))).toBeDefined(); // still credited
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0]?.chatId).toBe(USER);
  });

  it('advances the cursor past a transfer-free (dust/spam) scan', async () => {
    const { deps, db, chain } = makeFakeDeps();
    chain.scan = { ok: true, transfers: [], newestSig: 'spamSig' };

    await createDepositWatcher(deps).tick();

    expect(db.cursors.get(depositCursorStream(chain.treasuryPubkey()))).toBe('spamSig');
  });

  it('a failed scan moves nothing — cursor stays put', async () => {
    const { deps, db, chain } = makeFakeDeps();
    chain.scan = { ok: false, error: '429' };

    await createDepositWatcher(deps).tick();

    expect(db.cursors.size).toBe(0);
    expect(db.deposits.size).toBe(0);
  });

  it('skips the tick entirely when the singleton lock is held elsewhere', async () => {
    const { deps, db, chain } = makeFakeDeps();
    db.seedLink(USER, SENDER, GROUP);
    db.cronLockGranted = false;
    chain.setScanTransfers([transfer({ sig: 'sigA' })]);

    await createDepositWatcher(deps).tick();

    expect(db.ledger).toHaveLength(0);
    expect(db.cursors.size).toBe(0);
  });
});

describe('legacy orphan deposits remain ops-only reconciliation items', () => {
  it('classifies matching orphan deposits without crediting or attributing them', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedOrphanDeposit({ tx_sig: 'old1', ix_index: 0, sender_pubkey: SENDER, lamports: 5_000_000n });
    db.seedOrphanDeposit({ tx_sig: 'old2', ix_index: 1, sender_pubkey: SENDER, lamports: 2_000_000n });
    db.seedOrphanDeposit({ tx_sig: 'other', ix_index: 0, sender_pubkey: 'SomeoneElse', lamports: 9_000_000n });

    const summary = await classifyOrphanDepositsForOps(deps, SENDER);

    expect(summary).toEqual({
      orphanCount: 2,
      totalLamports: 7_000_000n,
      creditableCount: 2,
      dustCount: 0,
      reason: 'ops_reconciliation_required',
    });
    expect(await db.balanceLamports(USER)).toBe(0n);
    expect(db.ledger).toHaveLength(0);
    expect(db.deposits.get('old1:0')?.user_id).toBeNull();
    expect(db.deposits.get('old1:0')?.credited_at).toBeNull();
    expect(db.deposits.get('other:0')?.user_id).toBeNull(); // someone else's orphan untouched
  });

  it('reports dust separately and still leaves the orphan untouched', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedOrphanDeposit({
      tx_sig: 'dust',
      ix_index: 0,
      sender_pubkey: SENDER,
      lamports: WAGER_TUNABLES.MIN_DEPOSIT_LAMPORTS - 1n,
    });
    const summary = await classifyOrphanDepositsForOps(deps, SENDER);
    expect(summary).toEqual({
      orphanCount: 1,
      totalLamports: WAGER_TUNABLES.MIN_DEPOSIT_LAMPORTS - 1n,
      creditableCount: 0,
      dustCount: 1,
      reason: 'ops_reconciliation_required',
    });
    expect(await db.balanceLamports(USER)).toBe(0n);
    expect(db.deposits.get('dust:0')?.credited_at).toBeNull();
  });

  it('returns a no-op summary when the sender has no orphan deposits', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedOrphanDeposit({
      tx_sig: 'other',
      ix_index: 0,
      sender_pubkey: 'SomeoneElse',
      lamports: 5_000_000n,
    });
    expect(await classifyOrphanDepositsForOps(deps, SENDER)).toEqual({
      orphanCount: 0,
      totalLamports: 0n,
      creditableCount: 0,
      dustCount: 0,
      reason: 'none',
    });
    expect(db.ledger).toHaveLength(0);
  });
});
