import { describe, expect, it } from 'vitest';
import { DbError } from './errors.js';
import { wagerDbFromClient } from './wager-db.js';
import {
  GROUP_ID,
  MARKET_ID,
  UNSAFE_BIGINT,
  USER_ID,
  makeHarness,
} from './wager-db-test-support.js';
import type { WagerStakeInput } from './wager-types.js';

describe('security-definer RPCs', () => {
  const stakeInput: WagerStakeInput = {
    user_id: USER_ID,
    group_id: GROUP_ID,
    market_id: MARKET_ID,
    side: 'back',
    lamports: 10_000_000n,
    multiplier: 1.6,
    state: 'pending',
    placed_at_ms: 1_751_630_000_000,
    allow_starter: false,
  };

  it('rejects a malformed injected database client at the facade boundary', () => {
    expect(() => Reflect.apply(wagerDbFromClient, undefined, [{ from: () => ({}) }])).toThrow(
      DbError,
    );
  });

  it('forwards stake arguments under the SQL parameter names', async () => {
    const { db, fake } = makeHarness();
    fake.onRpc('wager_stake', () => ({ data: { ok: true, position_id: 'pos-1' }, error: null }));
    expect(await db.wagerStake(stakeInput)).toEqual({ ok: true, position_id: 'pos-1' });
    expect(fake.rpcCalls).toEqual([
      {
        fn: 'wager_stake',
        args: {
          p_user_id: USER_ID,
          p_group_id: GROUP_ID,
          p_market_id: MARKET_ID,
          p_side: 'back',
          p_lamports: 10_000_000, // bigint converted to a JSON-safe number
          p_multiplier: 1.6,
          p_state: 'pending',
          p_placed_at_ms: 1_751_630_000_000,
          p_idempotency_key: null, // absent on the button path
          p_allow_starter: false,
        },
      },
    ]);
  });

  it('forwards the client idempotency key, starter flag, and maps a duplicate reply', async () => {
    const { db, fake } = makeHarness();
    fake.onRpc('wager_stake', () => ({ data: { ok: true, duplicate: true }, error: null }));
    expect(await db.wagerStake({ ...stakeInput, idempotency_key: 'call-9', allow_starter: true })).toEqual({
      ok: true,
      duplicate: true,
    });
    expect(fake.rpcCalls[0]?.args.p_idempotency_key).toBe('call-9');
    expect(fake.rpcCalls[0]?.args.p_allow_starter).toBe(true);
  });

  it('maps every typed stake rejection code', async () => {
    const codes = [
      'insufficient',
      'wrong_side',
      'cap',
      'paused',
      'closed',
      'starter_unavailable',
      'budget_exhausted',
      'wallet_required',
    ] as const;
    for (const code of codes) {
      const { db, fake } = makeHarness();
      fake.onRpc('wager_stake', () => ({ data: { ok: false, code }, error: null }));
      expect(await db.wagerStake(stakeInput)).toEqual({ ok: false, code });
    }
  });

  it('fails loud on SQL/TS drift: unknown codes and malformed payloads', async () => {
    const malformedPayloads: unknown[] = [
      { ok: false, code: 'not_a_real_code' },
      { ok: true }, // missing position_id
      { ok: true, position_id: '' },
      { ok: true, duplicate: true, position_id: 'pos-1' },
      { unexpected: true }, // missing ok flag
      'weird',
    ];
    for (const payload of malformedPayloads) {
      const { db, fake } = makeHarness();
      fake.onRpc('wager_stake', () => ({ data: payload, error: null }));
      await expect(db.wagerStake(stakeInput)).rejects.toThrow(DbError);
    }
    const { db, fake } = makeHarness();
    fake.onRpc('wager_stake', () => ({ data: null, error: { message: 'boom' } }));
    await expect(db.wagerStake(stakeInput)).rejects.toThrow(DbError);
  });

  it('rejects unsafe stake lamports before the RPC is ever invoked', async () => {
    const { db, fake } = makeHarness();
    fake.onRpc('wager_stake', () => ({ data: { ok: true, position_id: 'pos-1' }, error: null }));
    await expect(db.wagerStake({ ...stakeInput, lamports: UNSAFE_BIGINT })).rejects.toThrow(DbError);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('requestWithdrawal maps ok and typed rejection codes', async () => {
    const ok = makeHarness();
    ok.fake.onRpc('wager_request_withdrawal', (args) => {
      expect(args).toEqual({ p_user_id: USER_ID, p_lamports: 10_000_000 });
      return { data: { ok: true, withdrawal_id: 'w-1' }, error: null };
    });
    expect(await ok.db.requestWithdrawal({ user_id: USER_ID, lamports: 10_000_000n })).toEqual({
      ok: true,
      withdrawal_id: 'w-1',
    });

    for (const code of ['no_wallet', 'insufficient'] as const) {
      const { db, fake } = makeHarness();
      fake.onRpc('wager_request_withdrawal', () => ({ data: { ok: false, code }, error: null }));
      expect(await db.requestWithdrawal({ user_id: USER_ID, lamports: 10_000_000n })).toEqual({
        ok: false,
        code,
      });
    }

    const unsafe = makeHarness();
    await expect(
      unsafe.db.requestWithdrawal({ user_id: USER_ID, lamports: UNSAFE_BIGINT }),
    ).rejects.toThrow(DbError);
    expect(unsafe.fake.rpcCalls).toHaveLength(0);
  });
});

