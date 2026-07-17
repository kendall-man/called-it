import { describe, expect, it } from 'vitest';
import { DbError } from './errors.js';
import { makeHarness } from './wager-db-test-support.js';

describe('wager hardening RPC facade', () => {
  it('maps current-wallet deposit attribution, replay, and permanent orphan codes', async () => {
    const outcomes = [
      { ok: true, outcome: 'credited', user_id: 7 },
      { ok: true, outcome: 'already_credited', user_id: 7 },
      { ok: false, code: 'unlinked_sender' },
      { ok: false, code: 'stale_wallet' },
      { ok: false, code: 'unverified_wallet' },
      { ok: false, code: 'below_minimum' },
      { ok: false, code: 'legacy_orphan' },
    ] as const;

    for (const payload of outcomes) {
      const { db, fake } = makeHarness();
      fake.onRpc('wager_credit_deposit', () => ({ data: payload, error: null }));
      await expect(
        db.creditDepositToCurrentVerifiedWallet({
          tx_sig: 'sig-a',
          ix_index: 2,
          min_lamports: 1_000_000n,
        }),
      ).resolves.toEqual(payload);
    }
  });

  it('rejects malformed atomic deposit outcomes instead of guessing an attribution', async () => {
    const { db, fake } = makeHarness();
    fake.onRpc('wager_credit_deposit', () => ({ data: { ok: true, outcome: 'credited' }, error: null }));
    await expect(
      db.creditDepositToCurrentVerifiedWallet({
        tx_sig: 'sig-a',
        ix_index: 2,
        min_lamports: 1_000_000n,
      }),
    ).rejects.toThrow(DbError);
  });

  it('parses every complete solvency reserve and the aggregate-only legacy classifier', async () => {
    const { db, fake } = makeHarness();
    fake.onRpc('wager_solvency_snapshot', () => ({
      data: {
        positive_ledger_lamports: 20,
        open_escrow_lamports: 30,
        pending_withdrawal_lamports: 40,
        remaining_starter_cap_lamports: 50,
      },
      error: null,
    }));
    fake.onRpc('wager_classify_legacy_reconciliation', () => ({
      data: {
        unresolved_count: 3,
        unverified_link_count: 1,
        orphan_deposit_count: 2,
        reasons: [
          { kind: 'orphan_deposit', reason: 'stale_wallet', count: 2 },
          { kind: 'unverified_link', reason: 'pre_migration_unverified_link', count: 1 },
        ],
      },
      error: null,
    }));

    await expect(db.getSolvencySnapshot()).resolves.toEqual({
      positive_ledger_lamports: 20n,
      open_escrow_lamports: 30n,
      pending_withdrawal_lamports: 40n,
      remaining_starter_cap_lamports: 50n,
    });
    await expect(db.classifyLegacyWalletReconciliation()).resolves.toEqual({
      unresolved_count: 3,
      unverified_link_count: 1,
      orphan_deposit_count: 2,
      reasons: [
        { kind: 'orphan_deposit', reason: 'stale_wallet', count: 2 },
        { kind: 'unverified_link', reason: 'pre_migration_unverified_link', count: 1 },
      ],
    });
  });
});
