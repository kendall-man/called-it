import { describe, expect, it } from 'vitest';
import { DbError } from './errors.js';
import {
  MARKET_ID,
  NOW_ISO,
  OTHER_USER_ID,
  UNSAFE_BIGINT,
  UNSAFE_INTEGER,
  USER_ID,
  makeHarness,
  withdrawalRow,
} from './wager-db-test-support.js';

describe('deposits', () => {
  const deposit = {
    tx_sig: 'sig1',
    ix_index: 0,
    sender_pubkey: 'SenderPubkey11111111111111111111111111111111',
    lamports: 10_000_000n,
    slot: 250,
  };

  it('upsertDeposit is idempotent on (tx_sig, ix_index)', async () => {
    const { db, fake } = makeHarness();
    expect(await db.upsertDeposit(deposit)).toEqual({ inserted: true });
    // Same instruction re-observed → ignored.
    expect(await db.upsertDeposit(deposit)).toEqual({ inserted: false });
    // Second transfer in the SAME transaction (distinct ix_index) → new row.
    expect(await db.upsertDeposit({ ...deposit, ix_index: 1 })).toEqual({ inserted: true });
    expect(fake.rows('wager_deposits')).toHaveLength(2);
    expect(fake.rows('wager_deposits')[0]?.lamports).toBe(10_000_000);
  });

  it('rejects unsafe lamports before writing', async () => {
    const { db, fake } = makeHarness();
    await expect(db.upsertDeposit({ ...deposit, lamports: UNSAFE_BIGINT })).rejects.toThrow(DbError);
    expect(fake.rows('wager_deposits')).toHaveLength(0);
  });

  it('markDepositCredited attributes exactly once', async () => {
    const { db, fake } = makeHarness();
    await db.upsertDeposit(deposit);
    await db.markDepositCredited('sig1', 0, USER_ID);
    expect(fake.rows('wager_deposits')[0]).toMatchObject({ user_id: USER_ID });
    expect(fake.rows('wager_deposits')[0]?.credited_at).toBeTruthy();
    // Already credited → no-op, attribution never moves.
    await db.markDepositCredited('sig1', 0, OTHER_USER_ID);
    expect(fake.rows('wager_deposits')[0]?.user_id).toBe(USER_ID);
    expect(await db.orphanDepositsBySender(deposit.sender_pubkey)).toHaveLength(0);
  });

  it('orphanDepositsBySender returns only uncredited rows, lamports as bigint', async () => {
    const { db } = makeHarness();
    await db.upsertDeposit(deposit);
    await db.upsertDeposit({ ...deposit, tx_sig: 'sig2' });
    await db.markDepositCredited('sig2', 0, USER_ID);
    await db.upsertDeposit({ ...deposit, tx_sig: 'sig3', sender_pubkey: 'OtherSender' });
    const orphans = await db.orphanDepositsBySender(deposit.sender_pubkey);
    expect(orphans.map((row) => row.tx_sig)).toEqual(['sig1']);
    expect(orphans[0]?.lamports).toBe(10_000_000n);
  });

  it('rejects malformed deposit rows returned by the database', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_deposits', [
      {
        id: 1,
        tx_sig: 99,
        ix_index: 0,
        sender_pubkey: deposit.sender_pubkey,
        lamports: 10_000_000,
        slot: 250,
        user_id: null,
        credited_at: null,
        observed_at: NOW_ISO,
      },
    ]);
    await expect(db.orphanDepositsBySender(deposit.sender_pubkey)).rejects.toThrow(DbError);
  });
});

describe('withdrawal outbox transitions', () => {
  const SIGNED = {
    tx_sig: 'txsig-1',
    raw_tx_b64: 'AAAA',
    last_valid_block_height: 12345,
  };

  it('walks the happy path debited → submitted → confirmed', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_withdrawals', [withdrawalRow()]);
    await db.markWithdrawalSubmitted('w-1', SIGNED);
    expect(fake.rows('wager_withdrawals')[0]).toMatchObject({ state: 'submitted', ...SIGNED });
    await db.markWithdrawalConfirmed('w-1');
    expect(fake.rows('wager_withdrawals')[0]?.state).toBe('confirmed');
  });

  it('supports re-sign after expiry: submitted → submitted with fresh tx facts', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_withdrawals', [withdrawalRow({ state: 'submitted', ...SIGNED })]);
    const fresh = { tx_sig: 'txsig-2', raw_tx_b64: 'BBBB', last_valid_block_height: 23456 };
    await db.markWithdrawalSubmitted('w-1', fresh);
    expect(fake.rows('wager_withdrawals')[0]).toMatchObject({ state: 'submitted', ...fresh });
  });

  it('refuses illegal transitions (terminal states are immutable)', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_withdrawals', [withdrawalRow()]);
    // confirmed straight from 'debited' is a bug — nothing was broadcast.
    await db.markWithdrawalConfirmed('w-1');
    expect(fake.rows('wager_withdrawals')[0]?.state).toBe('debited');

    fake.seed('wager_withdrawals', [withdrawalRow({ id: 'w-2', state: 'confirmed' })]);
    await db.markWithdrawalSubmitted('w-2', SIGNED);
    await db.markWithdrawalFailed('w-2', 'boom');
    expect(fake.rows('wager_withdrawals')[1]).toMatchObject({ state: 'confirmed', error: null });
  });

  it('records failure with its error and rejects unsafe block heights', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_withdrawals', [withdrawalRow({ state: 'submitted' })]);
    await db.markWithdrawalFailed('w-1', 'blockhash expired');
    expect(fake.rows('wager_withdrawals')[0]).toMatchObject({ state: 'failed', error: 'blockhash expired' });
    await expect(
      db.markWithdrawalSubmitted('w-1', { ...SIGNED, last_valid_block_height: UNSAFE_INTEGER }),
    ).rejects.toThrow(DbError);
  });

  it('withdrawalsInState filters by state and converts lamports to bigint', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_withdrawals', [
      withdrawalRow(),
      withdrawalRow({ id: 'w-2', state: 'submitted', ...SIGNED }),
    ]);
    const debited = await db.withdrawalsInState('debited');
    expect(debited.map((row) => row.id)).toEqual(['w-1']);
    expect(debited[0]?.lamports).toBe(10_000_000n);
    fake.seed('wager_withdrawals', [withdrawalRow({ id: 'w-3', lamports: UNSAFE_INTEGER })]);
    await expect(db.withdrawalsInState('debited')).rejects.toThrow(DbError);
  });

  it('rejects malformed withdrawal rows returned by the database', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_withdrawals', [withdrawalRow({ dest_pubkey: 99 })]);
    await expect(db.withdrawalsInState('debited')).rejects.toThrow(DbError);
  });
});

describe('settlement applied marker', () => {
  it('insertSettlementApplied is upsert-ignore idempotent', async () => {
    const { db, fake } = makeHarness();
    expect(await db.hasSettlementApplied(MARKET_ID)).toBe(false);
    await db.insertSettlementApplied(MARKET_ID);
    await db.insertSettlementApplied(MARKET_ID);
    expect(fake.rows('wager_settlements_applied')).toHaveLength(1);
    expect(await db.hasSettlementApplied(MARKET_ID)).toBe(true);
  });

  it('getSettlementOutcome reads the shared settlements table', async () => {
    const { db, fake } = makeHarness();
    expect(await db.getSettlementOutcome(MARKET_ID)).toBeNull();
    fake.seed('settlements', [{ market_id: MARKET_ID, outcome: 'claim_won' }]);
    expect(await db.getSettlementOutcome(MARKET_ID)).toBe('claim_won');
  });

  it('settledSolMarketsMissingApplied anti-joins settled/voided SOL markets', async () => {
    const { db, fake } = makeHarness();
    fake.seed('markets', [
      { id: 'm-settled', currency: 'sol', status: 'settled', is_replay: false },
      { id: 'm-voided', currency: 'sol', status: 'voided', is_replay: false },
      { id: 'm-open', currency: 'sol', status: 'open', is_replay: false },
      { id: 'm-rep', currency: 'rep', status: 'settled', is_replay: false },
    ]);
    fake.seed('wager_settlements_applied', [{ market_id: 'm-voided', applied_at: NOW_ISO }]);
    expect(await db.settledSolMarketsMissingApplied()).toEqual(['m-settled']);

    const empty = makeHarness();
    expect(await empty.db.settledSolMarketsMissingApplied()).toEqual([]);
  });
});

describe('circuit breaker', () => {
  it('reads and flips the persisted wager_status row', async () => {
    const { db, fake } = makeHarness();
    fake.seed('wager_status', [{ id: 1, paused: false, reason: null, updated_at: NOW_ISO }]);
    expect((await db.getWagerStatus()).paused).toBe(false);
    await db.setWagerStatus(true, 'solvency invariant violated');
    const status = await db.getWagerStatus();
    expect(status.paused).toBe(true);
    expect(status.reason).toBe('solvency invariant violated');
  });

  it('fails loud when the breaker row is missing', async () => {
    const { db } = makeHarness();
    await expect(db.getWagerStatus()).rejects.toThrow(DbError);
  });
});

describe('solvency queries', () => {
  it('openSolMarketIds returns non-terminal SOL markets only', async () => {
    const { db, fake } = makeHarness();
    fake.seed('markets', [
      { id: 'm-open', currency: 'sol', status: 'open' },
      { id: 'm-frozen', currency: 'sol', status: 'frozen' },
      { id: 'm-settled', currency: 'sol', status: 'settled' },
      { id: 'm-rep', currency: 'rep', status: 'open' },
    ]);
    expect(await db.openSolMarketIds()).toEqual(['m-open', 'm-frozen']);
  });
});
