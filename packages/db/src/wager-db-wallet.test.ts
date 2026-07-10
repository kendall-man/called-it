import { describe, expect, it } from 'vitest';
import { DbError } from './errors.js';
import {
  GROUP_ID,
  MARKET_ID,
  OTHER_USER_ID,
  USER_ID,
  makeHarness,
} from './wager-db-test-support.js';

describe('verified wallet RPC facade', () => {
  const CHALLENGE_ID = '00000000-0000-4000-8000-000000000111';
  const INTENT_ID = '00000000-0000-4000-8000-000000000222';
  const HASH_HEX = 'a'.repeat(64);
  const PUBKEY = 'PubkeyAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('forwards hashed challenge material and parses typed link outcomes', async () => {
    const { db, fake } = makeHarness();
    fake.onRpc('wager_verify_wallet_link', () => ({
      data: { ok: true, relinked: false, link_id: 9 },
      error: null,
    }));
    await expect(
      db.verifyWalletLink({
        challenge_id: CHALLENGE_ID,
        user_id: USER_ID,
        pubkey: PUBKEY,
        challenge_hash_hex: HASH_HEX,
      }),
    ).resolves.toEqual({ ok: true, relinked: false, link_id: 9 });
    expect(fake.rpcCalls[0]).toEqual({
      fn: 'wager_verify_wallet_link',
      args: {
        p_challenge_id: CHALLENGE_ID,
        p_user_id: USER_ID,
        p_pubkey: PUBKEY,
        p_challenge_hash_hex: HASH_HEX,
      },
    });
  });

  it('maps expected wallet refusals and rejects malformed RPC drift', async () => {
    for (const code of [
      'challenge_invalid',
      'challenge_expired',
      'pubkey_reserved',
      'balance_nonzero',
      'positions_open',
      'withdrawal_pending',
    ] as const) {
      const { db, fake } = makeHarness();
      fake.onRpc('wager_verify_wallet_link', () => ({ data: { ok: false, code }, error: null }));
      await expect(
        db.verifyWalletLink({
          challenge_id: CHALLENGE_ID,
          user_id: USER_ID,
          pubkey: PUBKEY,
          challenge_hash_hex: HASH_HEX,
        }),
      ).resolves.toEqual({ ok: false, code });
    }

    const { db, fake } = makeHarness();
    fake.onRpc('wager_verify_wallet_link', () => ({ data: { ok: false, code: 'weird' }, error: null }));
    await expect(
      db.verifyWalletLink({
        challenge_id: CHALLENGE_ID,
        user_id: USER_ID,
        pubkey: PUBKEY,
        challenge_hash_hex: HASH_HEX,
      }),
    ).rejects.toThrow(DbError);
  });

  it('keeps pending stake intent keys hashed and immutable at the facade boundary', async () => {
    const { db, fake } = makeHarness();
    fake.onRpc('wager_create_pending_stake_intent', () => ({
      data: { ok: true, intent_id: INTENT_ID, state: 'pending' },
      error: null,
    }));
    await expect(
      db.createPendingStakeIntent({
        user_id: USER_ID,
        group_id: GROUP_ID,
        market_id: MARKET_ID,
        side: 'back',
        lamports: 50_000_000n,
        intent_key_hash_hex: HASH_HEX,
        expires_at: '2026-07-10T12:10:00.000Z',
      }),
    ).resolves.toEqual({ ok: true, intent_id: INTENT_ID, state: 'pending' });
    expect(fake.rpcCalls[0]?.args).toMatchObject({
      p_user_id: USER_ID,
      p_group_id: GROUP_ID,
      p_market_id: MARKET_ID,
      p_side: 'back',
      p_lamports: 50_000_000,
      p_intent_key_hash_hex: HASH_HEX,
    });
  });

  it('resolves only the requested owner active intent and parses bigint lamports', async () => {
    const { db, fake } = makeHarness();
    fake.onRpc('wager_resolve_active_stake_intent', (args) => ({
      data:
        args.p_user_id === OTHER_USER_ID
          ? { ok: false, code: 'not_found' }
          : {
              ok: true,
              intent: {
                id: INTENT_ID,
                user_id: USER_ID,
                group_id: GROUP_ID,
                market_id: MARKET_ID,
                side: 'back',
                lamports: 50_000_000,
                state: 'ready',
                expires_at: '2026-07-10T12:10:00.000Z',
                created_at: '2026-07-10T12:00:00.000Z',
                updated_at: '2026-07-10T12:01:00.000Z',
              },
            },
      error: null,
    }));
    await expect(db.resolveActiveStakeIntent(USER_ID)).resolves.toMatchObject({
      ok: true,
      intent: { id: INTENT_ID, lamports: 50_000_000n },
    });
    await expect(db.resolveActiveStakeIntent(OTHER_USER_ID)).resolves.toEqual({
      ok: false,
      code: 'not_found',
    });
  });
});
