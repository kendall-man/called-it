import { describe, expect, it } from 'vitest';
import { wagerDbFromClient } from './wager-db.js';
import { starterOnlyWagerDbFromClient } from './wager-db-starter.js';
import { settlementDbMethods } from './wager-db-settlement.js';
import { FakeSupabase } from './wager-db-test-support.js';

const ALLOWED_GROUP_ID = -100_123;
const DISALLOWED_GROUP_IDS = [-100_456, -100_789] as const;

describe('wager settlement recovery query', () => {
  it('selects settled SOL markets only from the allowed groups', async () => {
    // Given one allowed and two disallowed settled SOL markets
    const fake = new FakeSupabase();
    fake.seed('markets', [
      {
        id: 'allowed-settled',
        group_id: ALLOWED_GROUP_ID,
        currency: 'sol',
        custody_mode: 'legacy',
        status: 'settled',
        is_replay: false,
      },
      {
        id: 'disallowed-settled',
        group_id: DISALLOWED_GROUP_IDS[0],
        currency: 'sol',
        custody_mode: 'legacy',
        status: 'settled',
        is_replay: false,
      },
      {
        id: 'disallowed-voided',
        group_id: DISALLOWED_GROUP_IDS[1],
        currency: 'sol',
        custody_mode: 'legacy',
        status: 'voided',
        is_replay: false,
      },
      {
        id: 'allowed-replay',
        group_id: ALLOWED_GROUP_ID,
        currency: 'sol',
        custody_mode: 'legacy',
        status: 'settled',
        is_replay: true,
      },
      {
        id: 'allowed-escrow-settled',
        group_id: ALLOWED_GROUP_ID,
        currency: 'sol',
        custody_mode: 'escrow',
        status: 'settled',
        is_replay: false,
      },
    ]);
    const db = settlementDbMethods(fake, [ALLOWED_GROUP_ID]);

    // When recovery discovers settled markets without an applied marker
    const marketIds = await db.settledSolMarketsMissingApplied();

    // Then the query returns only the market owned by the allowed group
    expect(marketIds).toEqual(['allowed-settled']);
  });

  it('binds the allowed groups into the starter-only database facade', async () => {
    // Given a starter facade over one allowed and one disallowed settled market
    const fake = new FakeSupabase();
    fake.seed('markets', [
      {
        id: 'allowed-settled',
        group_id: ALLOWED_GROUP_ID,
        currency: 'sol',
        custody_mode: 'legacy',
        status: 'settled',
        is_replay: false,
      },
      {
        id: 'disallowed-settled',
        group_id: DISALLOWED_GROUP_IDS[0],
        currency: 'sol',
        custody_mode: 'legacy',
        status: 'settled',
        is_replay: false,
      },
    ]);
    const db = starterOnlyWagerDbFromClient(fake, [ALLOWED_GROUP_ID]);

    // When recovery is invoked through its no-argument engine-facing method
    const marketIds = await db.settledSolMarketsMissingApplied();

    // Then the construction-time group scope remains enforced
    expect(marketIds).toEqual(['allowed-settled']);
  });

  it('keeps the funded database facade recovery explicitly unscoped', async () => {
    // Given settled SOL markets in two groups behind the funded facade
    const fake = new FakeSupabase();
    fake.seed('markets', [
      {
        id: 'first-funded-market',
        group_id: ALLOWED_GROUP_ID,
        currency: 'sol',
        custody_mode: 'legacy',
        status: 'settled',
        is_replay: false,
      },
      {
        id: 'second-funded-market',
        group_id: DISALLOWED_GROUP_IDS[0],
        currency: 'sol',
        custody_mode: 'legacy',
        status: 'voided',
        is_replay: false,
      },
      {
        id: 'funded-replay',
        group_id: ALLOWED_GROUP_ID,
        currency: 'sol',
        custody_mode: 'legacy',
        status: 'settled',
        is_replay: true,
      },
    ]);
    const db = wagerDbFromClient(fake);

    // When funded compatibility discovers markets without a group scope
    const marketIds = await db.settledSolMarketsMissingApplied();

    // Then all settled SOL markets remain recoverable
    expect(marketIds).toEqual(['first-funded-market', 'second-funded-market']);
  });

  it('selects only replay settlements that have real stake debits', async () => {
    const fake = new FakeSupabase();
    fake.seed('markets', [
      {
        id: 'legacy-free-replay',
        group_id: ALLOWED_GROUP_ID,
        currency: 'sol',
        custody_mode: 'legacy',
        status: 'settled',
        is_replay: true,
      },
      {
        id: 'funded-replay',
        group_id: ALLOWED_GROUP_ID,
        currency: 'sol',
        custody_mode: 'legacy',
        status: 'settled',
        is_replay: true,
      },
    ]);
    fake.seed('wager_ledger_entries', [{
      id: 1,
      user_id: 7001,
      group_id: ALLOWED_GROUP_ID,
      market_id: 'funded-replay',
      kind: 'stake',
      lamports: -10_000_000,
      idempotency_key: 'wager:stake:funded-replay',
    }]);
    const db = wagerDbFromClient(fake);

    const marketIds = await db.settledFundedReplayMarketsMissingApplied();

    expect(marketIds).toEqual(['funded-replay']);
  });

  it('sums only stake debits for the requested market', async () => {
    const fake = new FakeSupabase();
    fake.seed('wager_ledger_entries', [
      {
        id: 1,
        user_id: 7001,
        group_id: ALLOWED_GROUP_ID,
        market_id: 'funded-replay',
        kind: 'stake',
        lamports: -10_000_000,
        idempotency_key: 'wager:stake:one',
      },
      {
        id: 2,
        user_id: 7002,
        group_id: ALLOWED_GROUP_ID,
        market_id: 'funded-replay',
        kind: 'stake',
        lamports: -20_000_000,
        idempotency_key: 'wager:stake:two',
      },
      {
        id: 3,
        user_id: 7001,
        group_id: null,
        market_id: 'funded-replay',
        kind: 'payout',
        lamports: 30_000_000,
        idempotency_key: 'wager:payout:one',
      },
      {
        id: 4,
        user_id: 7003,
        group_id: ALLOWED_GROUP_ID,
        market_id: 'other-market',
        kind: 'stake',
        lamports: -50_000_000,
        idempotency_key: 'wager:stake:other',
      },
    ]);
    const db = wagerDbFromClient(fake);

    const debited = await db.stakeDebitedLamportsForMarket('funded-replay');

    expect(debited).toBe(30_000_000n);
  });
});
