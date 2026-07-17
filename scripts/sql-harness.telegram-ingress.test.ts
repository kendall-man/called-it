import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { discoverMigrationFiles } from './sql-harness/runner.js';
import {
  assertTelegramObjectsPresent,
  MIGRATIONS_DIR,
  persistTelegramUpdate,
  TELEGRAM_MIGRATION_NAME,
  telegramFingerprint,
  type TelegramLeaseResult,
  telegramMigration,
  telegramRpc,
  withMigratedTelegramDb,
} from './sql-harness/telegram-ingress-support.js';

const WORKER_A = '00000000-0000-4000-8000-000000000101';
const WORKER_B = '00000000-0000-4000-8000-000000000102';

test('tracks the Task 9 telegram migration after wallet identity', async () => {
  // Given the repository migration directory
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);

  // When we inspect the ordered filenames
  const names = migrations.map((migration) => migration.name);

  // Then the durable telegram migration exists exactly at 0006
  assert.ok(names.includes(TELEGRAM_MIGRATION_NAME));
  assert.ok(names.indexOf('0005_wallet_identity.sql') < names.indexOf(TELEGRAM_MIGRATION_NAME));
});

test('applies telegram ingress storage objects on fresh and upgrade paths', async () => {
  // Given the tracked migration set
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  const task9Migration = telegramMigration(migrations);

  // When the full chain applies fresh
  await withMigratedTelegramDb(migrations, async (client) => {
    // Then the Task 9 tables, functions, and no-policy contract exist
    await assertTelegramObjectsPresent(client);
  });

  // When 0006 is applied as an upgrade on top of 0001-0005
  await withMigratedTelegramDb(
    migrations.filter((migration) => migration.name <= '0005_wallet_identity.sql'),
    async (client) => {
      await client.query('insert into users (id, display_name) values ($1, $2)', [901, 'upgrade-sentinel']);
      await client.query(task9Migration.sql);

      const preserved = await client.query<{ readonly display_name: string }>('select display_name from users where id = $1', [901]);
      assert.deepEqual(preserved.rows, [{ display_name: 'upgrade-sentinel' }]);
      await assertTelegramObjectsPresent(client);
    },
  );
});

test('enforces immutable ingress routing, exclusive leases, retries, and terminal retention', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedTelegramDb(migrations, async (client, url) => {
    const first = await persistTelegramUpdate(client, 1, 'msg:-1001:1', 'pending_engine');
    assert.deepEqual(
      await telegramRpc(client, 'telegram_persist_update($1,$2,$3,$4,$5::jsonb,$6)', [
        'invalid:null-route',
        telegramFingerprint(10),
        10,
        'message',
        JSON.stringify({ update_id: 10, message: { message_id: 10, chat: { id: -1001 } } }),
        null,
      ]),
      { ok: false, code: 'invalid_input' },
    );
    const duplicate = await telegramRpc(client, 'telegram_persist_update($1,$2,$3,$4,$5::jsonb,$6)', [
      'msg:-1001:1',
      telegramFingerprint(1),
      1,
      'message',
      JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: -1001 } } }),
      'routed_concierge',
    ]);
    assert.deepEqual(duplicate, {
      ok: true,
      id: first.id,
      routing_decision: 'pending_engine',
      state: 'pending_engine',
      duplicate: true,
    });

    const second = await persistTelegramUpdate(client, 2, 'msg:-1001:2', 'pending_engine');
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      const lock = await pool.connect();
      try {
        await lock.query('begin');
        await lock.query('select id from telegram_updates where id = $1 for update', [first.id]);
        const leased = await telegramRpc<TelegramLeaseResult>(client, 'telegram_lease_updates($1,$2,$3)', [WORKER_A, 2, 60_000]);
        assert.deepEqual(leased.items.map((item) => item.id), [second.id]);
        await lock.query('rollback');
      } finally {
        lock.release();
      }
    } finally {
      await pool.end();
    }

    const leaseFirst = await telegramRpc<TelegramLeaseResult>(client, 'telegram_lease_updates($1,$2,$3)', [WORKER_A, 1, 60_000]);
    assert.deepEqual(leaseFirst.items.map((item) => item.id), [first.id]);
    assert.deepEqual(
      await telegramRpc(client, 'telegram_complete_update($1,$2)', [first.id, WORKER_B]),
      { ok: false, code: 'lease_lost' },
    );
    assert.deepEqual(
      await telegramRpc(client, 'telegram_retry_update($1,$2,$3,$4,$5)', [
        first.id,
        WORKER_A,
        'transient_failure',
        new Date(Date.now() - 1).toISOString(),
        1,
      ]),
      { ok: false, code: 'invalid_input' },
    );
    const retry = await telegramRpc(client, 'telegram_retry_update($1,$2,$3,$4,$5)', [
      first.id,
      WORKER_A,
      'transient_failure',
      new Date(Date.now() + 60_000).toISOString(),
      1,
    ]);
    assert.deepEqual(retry, { ok: true, id: first.id, state: 'dead', duplicate: false });
    assert.deepEqual(
      await telegramRpc(client, 'telegram_retry_update($1,$2,$3,$4,$5)', [
        first.id,
        WORKER_A,
        'different_error',
        new Date(Date.now() + 60_000).toISOString(),
        1,
      ]),
      { ok: true, id: first.id, state: 'dead', duplicate: true },
    );

    const completed = await persistTelegramUpdate(client, 3, 'msg:-1001:3', 'pending_engine');
    const leasedCompleted = await telegramRpc<TelegramLeaseResult>(client, 'telegram_lease_updates($1,$2,$3)', [WORKER_A, 1, 60_000]);
    assert.deepEqual(leasedCompleted.items.map((item) => item.id), [completed.id]);
    assert.deepEqual(
      await telegramRpc(client, 'telegram_complete_update($1,$2)', [completed.id, WORKER_A]),
      { ok: true, id: completed.id, state: 'completed', duplicate: false },
    );
    await client.query(
      "update telegram_updates set completed_at = clock_timestamp() - interval '7 days' where id = $1",
      [completed.id],
    );
    const prune = await telegramRpc(client, 'telegram_prune_delivery($1)', [10]);
    assert.equal(prune.purged_payloads, 1);
    const retention = await client.query<{ readonly payload: unknown; readonly state: string }>(
      'select payload, state from telegram_updates where id = $1',
      [completed.id],
    );
    assert.deepEqual(retention.rows, [{ payload: null, state: 'completed' }]);
  });
});

test('rejects malformed non-leased ingress rows and reports the oldest active backlog age', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedTelegramDb(migrations, async (client) => {
    await assert.rejects(
      client.query(
        `insert into telegram_updates (
           source_key, source_fingerprint, telegram_update_id, update_type, payload,
           routing_decision, state, lease_owner
         ) values ($1, $2, $3, 'message', $4::jsonb, 'pending_engine', 'pending_engine', $5::uuid)`,
        [
          'invalid:partial-lease',
          telegramFingerprint(11),
          11,
          JSON.stringify({ update_id: 11, message: { message_id: 11, chat: { id: -1001 } } }),
          WORKER_A,
        ],
      ),
      /check constraint/,
    );

    const older = await persistTelegramUpdate(client, 12, 'msg:-1001:12', 'pending_engine');
    await persistTelegramUpdate(client, 13, 'msg:-1001:13', 'pending_engine');
    await client.query(
      "update telegram_updates set received_at = clock_timestamp() - interval '10 minutes' where id = $1",
      [older.id],
    );
    const snapshot = await telegramRpc(client, 'telegram_delivery_snapshot($1)', [new Date().toISOString()]);
    assert.equal(snapshot.ingress_active_count, 2);
    assert.ok(
      typeof snapshot.ingress_oldest_age_ms === 'number' && snapshot.ingress_oldest_age_ms >= 590_000,
      `expected oldest backlog age near ten minutes, received ${String(snapshot.ingress_oldest_age_ms)}`,
    );
  });
});

test('keeps outbound ownership exclusive and denies non-service roles', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedTelegramDb(migrations, async (client) => {
    const planned = await telegramRpc(client, 'telegram_plan_outbound($1,$2,$3,$4)', [
      'market-card:1',
      -1001,
      'market_card',
      'market:1',
    ]);
    const started = await telegramRpc(client, 'telegram_start_outbound($1,$2,$3)', [planned.id, WORKER_A, 60_000]);
    assert.equal(started.state, 'sending');
    assert.deepEqual(
      await telegramRpc(client, 'telegram_mark_outbound_owned($1,$2,$3)', [planned.id, WORKER_A, 77]),
      { ok: true, id: planned.id, state: 'owned', duplicate: false },
    );
    const ownershipLease = await client.query<{
      readonly lease_owner: string | null;
      readonly lease_expires_at: string | null;
    }>(
      'select lease_owner, lease_expires_at from telegram_outbound_ownership_jobs where id = $1',
      [planned.id],
    );
    assert.equal(ownershipLease.rows[0]?.lease_owner, null);
    assert.equal(ownershipLease.rows[0]?.lease_expires_at, null);
    const completionLease = await telegramRpc<TelegramLeaseResult>(
      client,
      'telegram_lease_outbound_completion($1,$2,$3)',
      [WORKER_A, 1, 60_000],
    );
    assert.deepEqual(completionLease.items.map((item) => item.id), [planned.id]);
    assert.deepEqual(
      await telegramRpc(client, 'telegram_complete_outbound($1,$2)', [planned.id, WORKER_B]),
      { ok: false, code: 'lease_lost' },
    );
    assert.deepEqual(
      await telegramRpc(client, 'telegram_complete_outbound($1,$2)', [planned.id, WORKER_A]),
      { ok: true, id: planned.id, state: 'complete', duplicate: false },
    );
    assert.deepEqual(
      await telegramRpc(client, 'telegram_resolve_owned_message($1,$2)', [-1001, 77]),
      { ok: true, owner: 'engine', job_id: planned.id, domain_kind: 'market_card', domain_id: 'market:1' },
    );

    await client.query('set role anon');
    try {
      await assert.rejects(client.query('select * from telegram_updates'), /permission denied|row-level security/);
      await assert.rejects(
        client.query("select telegram_persist_update('x', repeat('A', 43), 1, 'message', '{}'::jsonb, 'pending_engine')"),
        /permission denied/,
      );
    } finally {
      await client.query('reset role');
    }
  });
});
