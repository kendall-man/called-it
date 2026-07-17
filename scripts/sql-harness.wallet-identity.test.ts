import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { discoverMigrationFiles } from './sql-harness/runner.js';
import { validateCalledItSchema } from './sql-harness/schema-checks.js';
import {
  seedMarket,
  withMigratedDb,
} from './sql-harness/starter-grant-support.js';
import {
  assertWalletFunctionPrivileges,
  countRows,
  createChallenge,
  createIntent,
  GROUP_ID,
  HASH_A,
  HASH_B,
  INTENT_HASH,
  linkSnapshot,
  MIGRATIONS_DIR,
  OTHER_USER_ID,
  PUBKEY_A,
  PUBKEY_B,
  rpc,
  secretSnapshot,
  seedWalletFixtures,
  USER_ID,
  verify,
} from './sql-harness/wallet-identity-support.js';

const TAP_PATH = join(process.cwd(), '.omo/evidence/task-8-called-it-direct-onboarding-remediation.sql.tap');
const tapLines: string[] = ['TAP version 13'];
let tapCount = 0;

test.after(async () => {
  tapLines.push(`1..${tapCount}`);
  await mkdir(dirname(TAP_PATH), { recursive: true });
  await writeFile(TAP_PATH, `${tapLines.join('\n')}\n`);
});

test('wallet identity migrations apply fresh and as 0001-0004 upgrade', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async () => undefined);
  record('fresh wallet migration chain applied through Privy identity and cleaned');
  await withMigratedDb(migrations.filter((migration) => migration.name <= '0004_starter_grant.sql'), async (client) => {
    const fifth = migrations.find((migration) => migration.name === '0005_wallet_identity.sql');
    assert.ok(fifth);
    await client.query(fifth.sql);
    await validateCalledItSchema(client, {
      telegram: false,
      settlementProofJobs: false,
      publicProductViews: false,
    });
  });
  record('upgraded 0001-0004 plus 0005 applied and cleaned');
});

test('browser wallet link sessions are private, single-use, and owner-bound', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async (client, url) => {
    await seedWalletFixtures(client);
    const challengeId = 'f4f99fac-3cd6-46f5-abf6-c5f7b20c6238';
    const pubkey = '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk';
    const session = await rpc(client, 'wager_create_wallet_link_session($1,$2,$3,$4)', [
      USER_ID,
      HASH_A,
      new Date(Date.now() + 10 * 60_000).toISOString(),
      'devnet',
    ]);
    assert.equal(session.ok, true);

    const challenge = await rpc(
      client,
      'wager_create_wallet_link_challenge($1,$2,$3,$4,$5)',
      [
        HASH_A,
        challengeId,
        pubkey,
        HASH_B,
        new Date(Date.now() + 5 * 60_000).toISOString(),
      ],
    );
    assert.equal(challenge.ok, true);
    assert.equal(challenge.user_id, USER_ID);
    assert.deepEqual(
      await rpc(client, 'wager_get_wallet_link_challenge($1,$2)', [HASH_A, challengeId]),
      {
        ok: true,
        user_id: USER_ID,
        pubkey,
        issued_at: challenge.issued_at,
        expires_at: challenge.expires_at,
        challenge_hash_hex: HASH_B,
      },
    );

    const verified = await rpc(
      client,
      'wager_verify_wallet_link_session($1,$2,$3,$4)',
      [HASH_A, challengeId, pubkey, HASH_B],
    );
    assert.equal(verified.ok, true);
    assert.deepEqual(
      await rpc(client, 'wager_verify_wallet_link_session($1,$2,$3,$4)', [
        HASH_A,
        challengeId,
        pubkey,
        HASH_B,
      ]),
      { ok: false, code: 'session_invalid' },
    );

    const secretColumns = await client.query<{ count: string }>(
      `select count(*)::text as count
       from information_schema.columns
       where table_name = 'wager_wallet_link_sessions'
         and column_name in ('token', 'raw_token', 'secret')`,
    );
    assert.equal(secretColumns.rows[0]?.count, '0');
    await assertWalletFunctionPrivileges(client, url);
  });
  record('one-time browser wallet session linked exactly once without storing its raw token');
});

test('Privy wallet links atomically reserve the provider identity and wallet', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async (client) => {
    await seedWalletFixtures(client);
    const challengeId = '1f3250a0-8868-43a1-8842-c8164d72f177';
    const pubkey = '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk';
    await rpc(client, 'wager_create_wallet_link_session($1,$2,$3,$4)', [
      USER_ID,
      HASH_A,
      new Date(Date.now() + 5 * 60_000).toISOString(),
      'devnet',
    ]);
    await rpc(client, 'wager_create_wallet_link_challenge($1,$2,$3,$4,$5)', [
      HASH_A,
      challengeId,
      pubkey,
      HASH_B,
      new Date(Date.now() + 4 * 60_000).toISOString(),
    ]);

    const linked = await rpc(
      client,
      'wager_verify_privy_wallet_link_session($1,$2,$3,$4,$5,$6,$7)',
      [HASH_A, challengeId, pubkey, HASH_B, 'did:privy:user-a', 'wallet-a', 'devnet'],
    );
    assert.equal(linked.ok, true);
    const stored = await client.query<{
      wallet_provider: string;
      provider_user_id: string;
      provider_wallet_id: string;
      solana_network: string;
    }>(
      `select wallet_provider, provider_user_id, provider_wallet_id, solana_network
       from wager_wallet_links where user_id = $1`,
      [USER_ID],
    );
    assert.deepEqual(stored.rows[0], {
      wallet_provider: 'privy',
      provider_user_id: 'did:privy:user-a',
      provider_wallet_id: 'wallet-a',
      solana_network: 'devnet',
    });

    const otherChallengeId = 'b87ce271-cbb4-439e-97d1-d5c37f108aaf';
    await rpc(client, 'wager_create_wallet_link_session($1,$2,$3,$4)', [
      OTHER_USER_ID,
      HASH_B,
      new Date(Date.now() + 5 * 60_000).toISOString(),
      'devnet',
    ]);
    await rpc(client, 'wager_create_wallet_link_challenge($1,$2,$3,$4,$5)', [
      HASH_B,
      otherChallengeId,
      PUBKEY_B,
      HASH_A,
      new Date(Date.now() + 4 * 60_000).toISOString(),
    ]);
    assert.deepEqual(
      await rpc(
        client,
        'wager_verify_privy_wallet_link_session($1,$2,$3,$4,$5,$6,$7)',
        [HASH_B, otherChallengeId, PUBKEY_B, HASH_A, 'did:privy:user-a', 'wallet-b', 'devnet'],
      ),
      { ok: false, code: 'privy_identity_reserved' },
    );
  });
  record('Privy user and embedded wallet metadata were installed atomically and reserved');
});

test('escrow Privy links retain independent devnet and mainnet wallets', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async (client, url) => {
    await seedWalletFixtures(client);
    const links = [
      {
        network: 'devnet',
        tokenHash: HASH_A,
        challengeHash: HASH_B,
        challengeId: '3890630e-972e-4693-ad7f-a2211bac75ed',
        pubkey: '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk',
        providerUserId: 'did:privy:devnet-user',
        providerWalletId: 'devnet-wallet',
      },
      {
        network: 'mainnet-beta',
        tokenHash: HASH_B,
        challengeHash: HASH_A,
        challengeId: '52e79ebc-7b8f-4214-9dad-661bd143652c',
        pubkey: 'CQno4PgrUidMPUsWjo4P5nYARHR2mofCvZXL6nJHAssp',
        providerUserId: 'did:privy:mainnet-user',
        providerWalletId: 'mainnet-wallet',
      },
    ] as const;

    for (const link of links) {
      assert.equal((await rpc(client, 'wager_create_wallet_link_session($1,$2,$3,$4)', [
        USER_ID,
        link.tokenHash,
        new Date(Date.now() + 5 * 60_000).toISOString(),
        link.network,
      ])).ok, true);
      assert.equal((await rpc(client, 'wager_create_wallet_link_challenge($1,$2,$3,$4,$5)', [
        link.tokenHash,
        link.challengeId,
        link.pubkey,
        link.challengeHash,
        new Date(Date.now() + 4 * 60_000).toISOString(),
      ])).ok, true);
      assert.deepEqual(
        await rpc(client, 'escrow_verify_privy_wallet_link_session($1,$2,$3,$4,$5,$6,$7)', [
          link.tokenHash,
          link.challengeId,
          link.pubkey,
          link.challengeHash,
          link.providerUserId,
          link.providerWalletId,
          link.network,
        ]),
        { ok: true, relinked: false },
      );
    }

    const stored = await client.query(
      `select solana_network, pubkey, provider_user_id, provider_wallet_id
       from escrow_wallet_links where user_id = $1 order by solana_network`,
      [USER_ID],
    );
    assert.deepEqual(stored.rows, [
      {
        solana_network: 'devnet',
        pubkey: links[0].pubkey,
        provider_user_id: links[0].providerUserId,
        provider_wallet_id: links[0].providerWalletId,
      },
      {
        solana_network: 'mainnet-beta',
        pubkey: links[1].pubkey,
        provider_user_id: links[1].providerUserId,
        provider_wallet_id: links[1].providerWalletId,
      },
    ]);

    const rls = await client.query(
      `select relrowsecurity as enabled
       from pg_class where oid = 'public.escrow_wallet_links'::regclass`,
    );
    assert.equal(rls.rows[0]?.enabled, true);
    await assertWalletFunctionPrivileges(client, url);
  });
  record('escrow wallet ownership remained network-scoped in one database');
});

test('verified wallet challenges are single-use, private, and relink guarded', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async (client, url) => {
    await seedWalletFixtures(client);
    const challenge = await createChallenge(client, USER_ID, PUBKEY_A, HASH_A, 5);
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      const attempts = await Promise.all([
        verify(pool, challenge, USER_ID, PUBKEY_A, HASH_A),
        verify(pool, challenge, USER_ID, PUBKEY_A, HASH_A),
      ]);
      assert.equal(attempts.filter((result) => result.ok).length, 1);
      assert.equal(attempts.filter((result) => !result.ok && result.code === 'challenge_invalid').length, 1);
    } finally {
      await pool.end();
    }
    assert.deepEqual(await secretSnapshot(client), {
      challengeRaw: '0',
      intentRaw: '0',
      challengeHashBytes: 32,
      intentHashBytes: null,
    });
    assert.equal(await countRows(client, 'wager_wallet_link_history'), 1);

    const beforeWrong = await linkSnapshot(client);
    assert.deepEqual(
      await verify(client, await createChallenge(client, USER_ID, PUBKEY_B, HASH_B, -1), USER_ID, PUBKEY_B, HASH_B),
      { ok: false, code: 'challenge_expired' },
    );
    assert.deepEqual(
      await verify(client, await createChallenge(client, USER_ID, PUBKEY_B, HASH_B, 5), OTHER_USER_ID, PUBKEY_B, HASH_B),
      { ok: false, code: 'challenge_invalid' },
    );
    assert.deepEqual(await linkSnapshot(client), beforeWrong);

    await client.query('insert into wager_ledger_entries (user_id, kind, lamports, idempotency_key) values ($1, $2, $3, $4)', [USER_ID, 'deposit', 1, 'wallet-block-balance']);
    assert.deepEqual(
      await verify(client, await createChallenge(client, USER_ID, PUBKEY_B, HASH_B, 5), USER_ID, PUBKEY_B, HASH_B),
      { ok: false, code: 'balance_nonzero' },
    );
    await client.query('delete from wager_ledger_entries where idempotency_key = $1', ['wallet-block-balance']);
    await client.query('insert into positions (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms) values ($1, $2, $3, $4, $5, $6, $7)', [(await seedMarket(client, { userId: 8510, groupId: -8510 })).marketId, USER_ID, 'back', 1, 2, 'active', 1]);
    assert.deepEqual(
      await verify(client, await createChallenge(client, USER_ID, PUBKEY_B, HASH_B, 5), USER_ID, PUBKEY_B, HASH_B),
      { ok: false, code: 'positions_open' },
    );
    await client.query('update positions set state = $1 where user_id = $2', ['void', USER_ID]);
    await client.query('insert into wager_withdrawals (user_id, dest_pubkey, lamports, state) values ($1, $2, $3, $4)', [USER_ID, PUBKEY_A, 1, 'debited']);
    assert.deepEqual(
      await verify(client, await createChallenge(client, USER_ID, PUBKEY_B, HASH_B, 5), USER_ID, PUBKEY_B, HASH_B),
      { ok: false, code: 'withdrawal_pending' },
    );
    await client.query('update wager_withdrawals set state = $1 where user_id = $2', ['confirmed', USER_ID]);
    const relinked = await verify(client, await createChallenge(client, USER_ID, PUBKEY_B, HASH_B, 5), USER_ID, PUBKEY_B, HASH_B);
    assert.deepEqual(relinked, { ok: true, relinked: true, link_id: 2 });
    assert.deepEqual(
      await verify(client, await createChallenge(client, OTHER_USER_ID, PUBKEY_A, HASH_A, 5), OTHER_USER_ID, PUBKEY_A, HASH_A),
      { ok: false, code: 'pubkey_reserved' },
    );
    await assert.rejects(
      client.query(
        'insert into wager_wallet_links (user_id, pubkey, verified_at) values ($1, $2, now())',
        [OTHER_USER_ID, PUBKEY_A],
      ),
      /violates foreign key constraint|null value in column "link_history_id"/,
    );
    const originalHistory = await client.query<{ id: number }>(
      'select id from wager_wallet_link_history where user_id = $1 and pubkey = $2',
      [USER_ID, PUBKEY_A],
    );
    const historyRow = originalHistory.rows[0];
    assert.ok(historyRow);
    await assert.rejects(
      client.query(
        'insert into wager_wallet_links (user_id, pubkey, verified_at, link_history_id) values ($1, $2, now(), $3)',
        [OTHER_USER_ID, PUBKEY_A, historyRow.id],
      ),
      /violates foreign key constraint/,
    );
    await assertWalletFunctionPrivileges(client, url);
  });
  record('challenge race, TTL, wrong-user, relink blockers, accepted relink and permanent pubkey reservation matched typed outcomes and structural constraints');
});

test('pending stake intents preserve immutable owner-bound state and consume once', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async (client, url) => {
    const fixture = await seedMarket(client, { userId: USER_ID, groupId: GROUP_ID });
    const created = await createIntent(client, fixture.marketId, INTENT_HASH, 'back', 50_000_000);
    assert.equal(created.ok, true);
    assert.equal((await createIntent(client, fixture.marketId, INTENT_HASH, 'doubt', 50_000_000)).code, 'field_mismatch');
    assert.equal((await createIntent(client, fixture.marketId, HASH_B, 'doubt', 50_000_000)).code, 'active_intent_exists');
    const owner = await rpc(client, 'wager_resolve_active_stake_intent($1)', [USER_ID]);
    assert.equal(owner.ok, true);
    assert.equal(owner.intent.user_id, USER_ID);
    assert.deepEqual(await rpc(client, 'wager_resolve_active_stake_intent($1)', [OTHER_USER_ID]), { ok: false, code: 'not_found' });
    assert.equal((await rpc(client, 'wager_mark_stake_intent_funded($1,$2)', [USER_ID, created.intent_id])).ok, true);
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      const [first, second] = await Promise.all([
        rpc(pool, 'wager_consume_ready_stake_intent($1,$2)', [USER_ID, created.intent_id]),
        rpc(pool, 'wager_consume_ready_stake_intent($1,$2)', [USER_ID, created.intent_id]),
      ]);
      assert.equal([first, second].filter((result) => result.ok).length, 1);
      assert.equal([first, second].filter((result) => !result.ok && result.code === 'not_ready').length, 1);
    } finally {
      await pool.end();
    }
    assert.equal((await countRows(client, 'positions')), 0);
    assert.deepEqual(
      await createIntent(client, fixture.marketId, HASH_A, 'back', 10_000_000, -1),
      { ok: false, code: 'expired' },
    );
  });
  record('owner-only active intent resolution, immutable field mismatch, active conflict, funding and single consume were enforced');
});

function record(message: string): void {
  tapCount += 1;
  tapLines.push(`ok ${tapCount} - ${message}`);
}
