import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { discoverMigrationFiles } from './sql-harness/runner.js';
import { seedMarket, withMigratedDb } from './sql-harness/starter-grant-support.js';
import {
  createChallenge,
  createIntentForUser,
  fulfilled,
  GROUP_ID,
  HASH_A,
  HASH_B,
  INTENT_HASH,
  MIGRATIONS_DIR,
  OTHER_USER_ID,
  PUBKEY_A,
  seedWalletFixtures,
  USER_ID,
  verify,
  withInsertDelay,
} from './sql-harness/wallet-identity-support.js';

test('cross-user wallet verification races return a typed pubkey_reserved outcome without leaking 23505', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async (client, url) => {
    await seedWalletFixtures(client);
    const challengeA = await createChallenge(client, USER_ID, PUBKEY_A, HASH_A, 5);
    const challengeB = await createChallenge(client, OTHER_USER_ID, PUBKEY_A, HASH_B, 5);
    await withInsertDelay(client, {
      functionName: 'delay_wallet_link_history_insert',
      triggerName: 'delay_wallet_link_history_insert',
      table: 'wager_wallet_link_history',
      predicate: `new.pubkey = '${PUBKEY_A}'`,
    }, async () => {
      const pool = new Pool({ connectionString: url, max: 2 });
      try {
        const results = fulfilled(await Promise.allSettled([
          verify(pool, challengeA, USER_ID, PUBKEY_A, HASH_A),
          verify(pool, challengeB, OTHER_USER_ID, PUBKEY_A, HASH_B),
        ]));
        assert.equal(results.filter((result) => result.ok).length, 1);
        assert.equal(results.filter((result) => !result.ok && result.code === 'pubkey_reserved').length, 1);
      } finally {
        await pool.end();
      }
    });
    const rows = await client.query<{ user_id: string; pubkey: string }>(
      'select user_id::text as user_id, pubkey from wager_wallet_link_history where pubkey = $1',
      [PUBKEY_A],
    );
    assert.equal(rows.rows.length, 1);
  });
});

test('cross-user pending-intent key races return a typed field_mismatch outcome without leaking 23505', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async (client, url) => {
    const fixture = await seedMarket(client, { userId: USER_ID, groupId: GROUP_ID });
    await client.query('insert into users (id, display_name) values ($1, $2)', [OTHER_USER_ID, 'o']);
    await withInsertDelay(client, {
      functionName: 'delay_pending_stake_intent_insert',
      triggerName: 'delay_pending_stake_intent_insert',
      table: 'wager_pending_stake_intents',
      predicate: `new.intent_key_hash = decode('${INTENT_HASH}', 'hex')`,
    }, async () => {
      const pool = new Pool({ connectionString: url, max: 2 });
      try {
        const results = fulfilled(await Promise.allSettled([
          createIntentForUser(pool, { userId: USER_ID, groupId: GROUP_ID, marketId: fixture.marketId, hash: INTENT_HASH, side: 'back', lamports: 50_000_000 }),
          createIntentForUser(pool, { userId: OTHER_USER_ID, groupId: GROUP_ID, marketId: fixture.marketId, hash: INTENT_HASH, side: 'back', lamports: 50_000_000 }),
        ]));
        assert.equal(results.filter((result) => result.ok).length, 1);
        assert.equal(results.filter((result) => !result.ok && result.code === 'field_mismatch').length, 1);
      } finally {
        await pool.end();
      }
    });
    const rows = await client.query<{ user_id: string; intent_key_hash: string }>(
      "select user_id::text as user_id, encode(intent_key_hash, 'hex') as intent_key_hash from wager_pending_stake_intents where intent_key_hash = decode($1, 'hex')",
      [INTENT_HASH],
    );
    assert.equal(rows.rows.length, 1);
  });
});
