import { describe, expect, it } from 'vitest';
import { DbError } from './errors.js';
import {
  assertSafeInteger,
  multMilli,
  stakePayoutLamports,
  WAGER_MULT_SCALE,
} from './wager-db.js';
import {
  GROUP_ID,
  OTHER_USER_ID,
  UNSAFE_BIGINT,
  UNSAFE_INTEGER,
  USER_ID,
  ledgerEntry,
  makeHarness,
} from './wager-db-test-support.js';

describe('liability math', () => {
  it('uses the frozen MULT_SCALE of 1000', () => {
    expect(WAGER_MULT_SCALE).toBe(1000);
  });

  it('multMilli quantizes multipliers to milli-units', () => {
    expect(multMilli(1)).toBe(1000n);
    expect(multMilli(1.6)).toBe(1600n);
    expect(multMilli(2.147)).toBe(2147n);
    // Float edge: must agree with SQL round((m * 1000)::float8) — both sides
    // evaluate the product in IEEE float64 before rounding.
    expect(multMilli(1.0005)).toBe(BigInt(Math.round(1.0005 * 1000)));
  });

  it('multMilli rejects non-finite and negative multipliers', () => {
    expect(() => multMilli(Number.NaN)).toThrow(DbError);
    expect(() => multMilli(Number.POSITIVE_INFINITY)).toThrow(DbError);
    expect(() => multMilli(-1)).toThrow(DbError);
  });

  it('stakePayoutLamports floors like the SQL bigint division', () => {
    expect(stakePayoutLamports(3n, 1333n)).toBe(3n); // floor(3.999)
    expect(stakePayoutLamports(7n, 1500n)).toBe(10n); // floor(10.5)
    expect(stakePayoutLamports(10_000_000n, 1600n)).toBe(16_000_000n);
    expect(stakePayoutLamports(1n, 999n)).toBe(0n);
  });

});

describe('assertSafeInteger', () => {
  it('passes safe integers through, including negatives', () => {
    expect(assertSafeInteger('t', Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(assertSafeInteger('t', -Number.MAX_SAFE_INTEGER)).toBe(-Number.MAX_SAFE_INTEGER);
    expect(assertSafeInteger('t', 0)).toBe(0);
  });

  it('throws DbError on precision-lossy or fractional values', () => {
    expect(() => assertSafeInteger('t', UNSAFE_INTEGER)).toThrow(DbError);
    expect(() => assertSafeInteger('t', 1.5)).toThrow(DbError);
    expect(() => assertSafeInteger('t', Number.NaN)).toThrow(DbError);
  });
});
// ── Façade behavior against the in-memory client ───────────────────────────

describe('group opt-in', () => {
  it('defaults to disabled and round-trips the toggle', async () => {
    const { db, fake } = makeHarness();
    expect(await db.isGroupEnabled(GROUP_ID)).toBe(false);
    await db.setGroupEnabled(GROUP_ID, true, USER_ID);
    expect(await db.isGroupEnabled(GROUP_ID)).toBe(true);
    await db.setGroupEnabled(GROUP_ID, false, OTHER_USER_ID);
    expect(await db.isGroupEnabled(GROUP_ID)).toBe(false);
    // Upsert on group_id: one row, last toggler recorded.
    expect(fake.rows('wager_groups')).toHaveLength(1);
    expect(fake.rows('wager_groups')[0]?.enabled_by).toBe(OTHER_USER_ID);
  });
});

describe('wallet links', () => {
  const PUBKEY_A = 'PubkeyAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const PUBKEY_B = 'PubkeyBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  it('links, re-links (same user), and enforces first-link-wins on pubkeys', async () => {
    const { db, fake } = makeHarness();
    expect(await db.linkWallet({ user_id: USER_ID, pubkey: PUBKEY_A })).toEqual({
      ok: true,
      relinked: false,
    });
    // Another user claiming the same pubkey loses: first-link-wins.
    expect(await db.linkWallet({ user_id: OTHER_USER_ID, pubkey: PUBKEY_A })).toEqual({
      ok: false,
      reason: 'pubkey_taken',
    });
    // Same pubkey again is idempotent, not a re-link.
    expect(await db.linkWallet({ user_id: USER_ID, pubkey: PUBKEY_A })).toEqual({
      ok: true,
      relinked: false,
    });
    // The original owner can move to a new pubkey (future attribution moves).
    expect(await db.linkWallet({ user_id: USER_ID, pubkey: PUBKEY_B })).toEqual({
      ok: true,
      relinked: true,
    });
    expect(fake.rows('wager_wallet_links')).toHaveLength(1);
    expect((await db.getWalletLink(USER_ID))?.pubkey).toBe(PUBKEY_B);
    expect(await db.getWalletLinkByPubkey(PUBKEY_A)).toBeNull();
    expect((await db.getWalletLinkByPubkey(PUBKEY_B))?.user_id).toBe(USER_ID);
  });

  it('keeps the first verified_at timestamp and supports unlink', async () => {
    const { db, fake } = makeHarness();
    await db.linkWallet({ user_id: USER_ID, pubkey: PUBKEY_A, last_wager_group_id: GROUP_ID });
    expect(fake.rows('wager_wallet_links')[0]?.last_wager_group_id).toBe(GROUP_ID);
    await db.markWalletVerified(USER_ID);
    const first = fake.rows('wager_wallet_links')[0]?.verified_at;
    expect(typeof first).toBe('string');
    // Second verification must not move the timestamp (guarded by .is null).
    await db.markWalletVerified(USER_ID);
    expect(fake.rows('wager_wallet_links')[0]?.verified_at).toBe(first);

    await db.setLastWagerGroup(USER_ID, GROUP_ID + 1);
    expect(fake.rows('wager_wallet_links')[0]?.last_wager_group_id).toBe(GROUP_ID + 1);

    await db.unlinkWallet(USER_ID);
    expect(await db.getWalletLink(USER_ID)).toBeNull();
  });
});

describe('wager ledger', () => {
  it('postWagerLedger dedupes on idempotency_key', async () => {
    const { db, fake } = makeHarness();
    expect(await db.postWagerLedger(ledgerEntry())).toEqual({ inserted: true });
    expect(await db.postWagerLedger(ledgerEntry({ lamports: 999n }))).toEqual({ inserted: false });
    expect(fake.rows('wager_ledger_entries')).toHaveLength(1);
    // The first write wins entirely — the duplicate's payload is discarded.
    expect(fake.rows('wager_ledger_entries')[0]?.lamports).toBe(10_000_000);
  });

  it('rejects lamports beyond the Number-safe range before writing', async () => {
    const { db, fake } = makeHarness();
    await expect(db.postWagerLedger(ledgerEntry({ lamports: UNSAFE_BIGINT }))).rejects.toThrow(DbError);
    await expect(db.postWagerLedger(ledgerEntry({ lamports: -UNSAFE_BIGINT }))).rejects.toThrow(DbError);
    expect(fake.rows('wager_ledger_entries')).toHaveLength(0);
  });

  it('balances are user-global bigint sums; other users are excluded', async () => {
    const { db } = makeHarness();
    await db.postWagerLedger(ledgerEntry({ lamports: 5n, idempotency_key: 'k1' }));
    await db.postWagerLedger(ledgerEntry({ lamports: -2n, idempotency_key: 'k2', kind: 'stake' }));
    await db.postWagerLedger(
      ledgerEntry({ lamports: 100n, idempotency_key: 'k3', user_id: OTHER_USER_ID }),
    );
    expect(await db.balanceLamports(USER_ID)).toBe(3n);
    expect(await db.totalLedgerLamports()).toBe(103n);
  });

  it('sums exceeding 2^53 stay exact in bigint; corrupt rows fail loud', async () => {
    const { db, fake } = makeHarness();
    // Each row is individually safe; the bigint total exceeds 2^53 and must
    // still come back exact (a number-typed sum would silently round).
    fake.seed('wager_ledger_entries', [
      { id: 1, user_id: USER_ID, lamports: Number.MAX_SAFE_INTEGER, idempotency_key: 'a' },
      { id: 2, user_id: USER_ID, lamports: Number.MAX_SAFE_INTEGER, idempotency_key: 'b' },
    ]);
    expect(await db.balanceLamports(USER_ID)).toBe(2n * BigInt(Number.MAX_SAFE_INTEGER));

    const corrupt = makeHarness();
    corrupt.fake.seed('wager_ledger_entries', [
      { id: 1, user_id: USER_ID, lamports: UNSAFE_INTEGER, idempotency_key: 'bad' },
    ]);
    await expect(corrupt.db.balanceLamports(USER_ID)).rejects.toThrow(DbError);
  });
});
