import { describe, expect, expectTypeOf, it } from 'vitest';
import { DbError } from './errors.js';
import { wagerDbFromClient } from './wager-db.js';
import type {
  StarterOnlyWagerDb,
  WagerSettlementLedgerEntry,
  WagerStarterStakeInput,
} from './wager-db-starter.js';
import { starterOnlyWagerDbFromClient } from './wager-db-starter.js';
import { FakeSupabase, GROUP_ID, MARKET_ID, NOW_ISO, USER_ID } from './wager-db-test-support.js';
import type { WagerLedgerEntry, WagerStakeInput } from './wager-types.js';

const starterStakeInput: WagerStarterStakeInput = {
  user_id: USER_ID,
  group_id: GROUP_ID,
  market_id: MARKET_ID,
  side: 'back',
  lamports: 10_000_000n,
  multiplier: 2,
  state: 'active',
  placed_at_ms: 1,
  idempotency_key: 'starter-only',
};

function successfulStakeFake(): FakeSupabase {
  const fake = new FakeSupabase();
  fake.onRpc('wager_stake', () => ({
    data: { ok: true, position_id: MARKET_ID },
    error: null,
  }));
  return fake;
}

function seededSharedFake(): FakeSupabase {
  const fake = new FakeSupabase();
  fake.seed('markets', [{
    id: MARKET_ID,
    currency: 'sol',
    status: 'settled',
    is_replay: false,
    quote_probability: 0.4,
  }]);
  fake.seed('settlements', [{ market_id: MARKET_ID, outcome: 'claim_won' }]);
  fake.seed('wager_status', [{
    id: 1,
    paused: false,
    reason: null,
    updated_at: NOW_ISO,
  }]);
  return fake;
}

async function sharedSnapshot(db: Pick<
  StarterOnlyWagerDb,
  | 'getMarketProbability'
  | 'getSettlementOutcome'
  | 'getWagerStatus'
  | 'hasSettlementApplied'
  | 'settledSolMarketsMissingApplied'
>) {
  return {
    probability: await db.getMarketProbability(MARKET_ID),
    outcome: await db.getSettlementOutcome(MARKET_ID),
    status: await db.getWagerStatus(),
    settlementApplied: await db.hasSettlementApplied(MARKET_ID),
    missingApplied: await db.settledSolMarketsMissingApplied(),
  };
}

describe('starter-only wager database facade', () => {
  it('does not expose funded stake or ledger inputs in its public type', () => {
    type HasFundedStakeMethod = 'wagerStake' extends keyof StarterOnlyWagerDb ? true : false;
    type AcceptsFundedStakeInput = WagerStakeInput extends WagerStarterStakeInput ? true : false;
    type AcceptsFundedLedgerInput = WagerLedgerEntry extends WagerSettlementLedgerEntry
      ? true
      : false;

    expectTypeOf<HasFundedStakeMethod>().toEqualTypeOf<false>();
    expectTypeOf<AcceptsFundedStakeInput>().toEqualTypeOf<false>();
    expectTypeOf<AcceptsFundedLedgerInput>().toEqualTypeOf<false>();
  });

  it('constructs only starter stake, circuit, ledger, and settlement capabilities', () => {
    const db = starterOnlyWagerDbFromClient(new FakeSupabase(), undefined);

    expect(Object.keys(db).sort()).toEqual([
      'getMarketProbability',
      'getSettlementOutcome',
      'getWagerStatus',
      'hasSettlementApplied',
      'insertSettlementApplied',
      'postWagerLedger',
      'settledSolMarketsMissingApplied',
      'wagerStarterStake',
    ]);
    expect(Reflect.get(db, 'wagerStake')).toBeUndefined();
  });

  it('binds starter mode when it sends a starter stake RPC', async () => {
    const fake = successfulStakeFake();
    const db = starterOnlyWagerDbFromClient(fake, undefined);

    await expect(db.wagerStarterStake(starterStakeInput)).resolves.toEqual({
      ok: true,
      position_id: MARKET_ID,
    });

    expect(fake.rpcCalls).toEqual([{
      fn: 'wager_stake',
      args: {
        p_user_id: USER_ID,
        p_group_id: GROUP_ID,
        p_market_id: MARKET_ID,
        p_side: 'back',
        p_lamports: 10_000_000,
        p_multiplier: 2,
        p_state: 'active',
        p_placed_at_ms: 1,
        p_idempotency_key: 'starter-only',
        p_starter_only: true,
      },
    }]);
  });

  it('cannot be switched to funded mode by an injected runtime selector', async () => {
    const fake = successfulStakeFake();
    const db = starterOnlyWagerDbFromClient(fake, undefined);
    const injectedRequest = { ...starterStakeInput, starterOnly: false };

    await expect(
      Reflect.apply(db.wagerStarterStake, db, [injectedRequest]),
    ).resolves.toEqual({ ok: true, position_id: MARKET_ID });

    expect(injectedRequest.starterOnly).toBe(false);
    expect(fake.rpcCalls[0]?.args.p_starter_only).toBe(true);
  });

  it('rejects non-settlement ledger effects at the runtime boundary', async () => {
    const fake = new FakeSupabase();
    const db = starterOnlyWagerDbFromClient(fake, undefined);
    const refund: WagerSettlementLedgerEntry = {
      user_id: USER_ID,
      group_id: null,
      market_id: MARKET_ID,
      kind: 'refund',
      lamports: 10_000_000n,
      idempotency_key: 'settlement:refund:1',
    };

    await expect(db.postWagerLedger(refund)).resolves.toEqual({ inserted: true });
    await expect(Reflect.apply(db.postWagerLedger, db, [{
      ...refund,
      kind: 'deposit',
      idempotency_key: 'injected-deposit',
    }])).rejects.toThrow(DbError);

    expect(fake.rows('wager_ledger_entries')).toHaveLength(1);
    expect(fake.rows('wager_ledger_entries')[0]?.kind).toBe('refund');
  });

  it('matches the full facade for shared settlement and status behavior', async () => {
    const starterFake = seededSharedFake();
    const fullFake = seededSharedFake();
    const starterDb = starterOnlyWagerDbFromClient(starterFake, undefined);
    const fullDb = wagerDbFromClient(fullFake);

    const [starterBefore, fullBefore] = await Promise.all([
      sharedSnapshot(starterDb),
      sharedSnapshot(fullDb),
    ]);
    expect(starterBefore).toEqual(fullBefore);
    expect(starterBefore.missingApplied).toEqual([MARKET_ID]);

    await Promise.all([
      starterDb.insertSettlementApplied(MARKET_ID),
      fullDb.insertSettlementApplied(MARKET_ID),
    ]);
    const [starterAfter, fullAfter] = await Promise.all([
      sharedSnapshot(starterDb),
      sharedSnapshot(fullDb),
    ]);

    expect(starterAfter).toEqual(fullAfter);
    expect(starterAfter.settlementApplied).toBe(true);
    expect(starterAfter.missingApplied).toEqual([]);
    expect(starterFake.rows('wager_settlements_applied')).toEqual(
      fullFake.rows('wager_settlements_applied'),
    );
  });
});
