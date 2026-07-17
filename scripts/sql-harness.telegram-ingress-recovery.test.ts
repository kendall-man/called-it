import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { discoverMigrationFiles } from './sql-harness/runner.js';
import {
  persistTelegramUpdate,
  telegramFingerprint,
  telegramRpc,
  withMigratedTelegramDb,
} from './sql-harness/telegram-ingress-support.js';

const WORKER_A = '00000000-0000-4000-8000-000000000201';
const WORKER_B = '00000000-0000-4000-8000-000000000202';
const SQL_EVIDENCE_PATH = join(
  process.cwd(),
  '.omo/evidence/task-9-called-it-direct-onboarding-remediation.sql.tap',
);
const evidence: string[] = [];

type IdResult = { readonly id: string };
type LeaseItems = { readonly items: readonly { readonly id: string; readonly attempts?: number }[] };
type CompletionLeaseItems = {
  readonly items: readonly {
    readonly id: string;
    readonly chat_id: number;
    readonly domain_kind: string;
    readonly domain_id: string;
    readonly state: 'owned' | 'reconciled';
    readonly telegram_message_id: number;
    readonly lease_expires_at: string;
  }[];
};

test.after(async () => {
  await mkdir(dirname(SQL_EVIDENCE_PATH), { recursive: true });
  await writeFile(
    SQL_EVIDENCE_PATH,
    ['TAP version 13', ...evidence.map((name, index) => `ok ${index + 1} - ${name}`), `1..${evidence.length}`].join('\n') + '\n',
  );
});

test('reclaims expired ingress work without allowing the old lease owner to mutate it', async () => {
  const migrations = await discoverMigrationFiles('packages/db/migrations');
  await withMigratedTelegramDb(migrations, async (client) => {
    const persisted = await persistTelegramUpdate(client, 201, 'msg:-2001:201', 'pending_engine');
    const firstLease = await telegramRpc<LeaseItems>(client, 'telegram_lease_updates($1,$2,$3)', [WORKER_A, 1, 60_000]);
    assert.deepEqual(firstLease.items.map((item) => item.id), [persisted.id]);
    await client.query(
      "update telegram_updates set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [persisted.id],
    );

    const recovered = await telegramRpc<LeaseItems>(client, 'telegram_lease_updates($1,$2,$3)', [WORKER_B, 1, 60_000]);
    const recoveredItem = recovered.items[0];
    assert.ok(recoveredItem);
    assert.equal(recoveredItem.id, persisted.id);
    assert.equal(recoveredItem.attempts, 2);
    assert.deepEqual(
      await telegramRpc(client, 'telegram_complete_update($1,$2)', [persisted.id, WORKER_A]),
      { ok: false, code: 'lease_lost' },
    );
    assert.deepEqual(
      await telegramRpc(client, 'telegram_complete_update($1,$2)', [persisted.id, WORKER_B]),
      { ok: true, id: persisted.id, state: 'completed', duplicate: false },
    );
    const row = await client.query<{ readonly last_error_code: string | null }>(
      'select last_error_code from telegram_updates where id = $1',
      [persisted.id],
    );
    assert.deepEqual(row.rows, [{ last_error_code: null }]);
  });
  recordEvidence('ingress lease recovery and ownership rejection');
});

test('turns expired outbound sends into uncertainty and reconciles without a resend path', async () => {
  const migrations = await discoverMigrationFiles('packages/db/migrations');
  await withMigratedTelegramDb(migrations, async (client) => {
    const reconciledJob = await makeUncertain(client, 'market-card:reconcile', 'market_card', 'market:reconcile');
    const leased = await telegramRpc<LeaseItems>(client, 'telegram_lease_uncertain_ownership($1,$2,$3)', [WORKER_B, 1, 60_000]);
    assert.deepEqual(leased.items.map((item) => item.id), [reconciledJob]);
    assert.deepEqual(
      await telegramRpc(client, 'telegram_reconcile_outbound($1,$2,$3)', [reconciledJob, WORKER_B, 501]),
      { ok: true, id: reconciledJob, state: 'reconciled', duplicate: false },
    );
    assert.deepEqual(
      await telegramRpc(client, 'telegram_start_outbound($1,$2,$3)', [reconciledJob, WORKER_A, 60_000]),
      { ok: false, code: 'terminal_state', state: 'reconciled' },
    );

    const collisionJob = await makeUncertain(client, 'market-card:collision', 'market_card', 'market:collision');
    await telegramRpc<LeaseItems>(client, 'telegram_lease_uncertain_ownership($1,$2,$3)', [WORKER_B, 1, 60_000]);
    assert.deepEqual(
      await telegramRpc(client, 'telegram_reconcile_outbound($1,$2,$3)', [collisionJob, WORKER_B, 501]),
      { ok: false, code: 'ownership_conflict' },
    );

    const unknownJob = await makeUncertain(client, 'unknown:manual', 'unknown_kind', 'unknown:manual');
    await telegramRpc<LeaseItems>(client, 'telegram_lease_uncertain_ownership($1,$2,$3)', [WORKER_B, 1, 60_000]);
    assert.deepEqual(
      await telegramRpc(client, 'telegram_manual_review_outbound($1,$2,$3)', [unknownJob, WORKER_B, 'authoritative_id_missing']),
      { ok: true, id: unknownJob, state: 'manual_review', duplicate: false },
    );
  });
  recordEvidence('outbound uncertainty reconciliation and manual review');
});

test('skip-locks owned and reconciled completion leases with immutable recovery data', async () => {
  const migrations = await discoverMigrationFiles('packages/db/migrations');
  await withMigratedTelegramDb(migrations, async (client, url) => {
    const ownedJob = await makeOwned(client, 'market-card:owned-recovery', 601);
    const reconciledJob = await makeUncertain(client, 'market-card:reconciled-recovery', 'market_card', 'market:reconciled-recovery');
    await telegramRpc<LeaseItems>(client, 'telegram_lease_uncertain_ownership($1,$2,$3)', [WORKER_A, 1, 60_000]);
    assert.deepEqual(
      await telegramRpc(client, 'telegram_reconcile_outbound($1,$2,$3)', [reconciledJob, WORKER_A, 602]),
      { ok: true, id: reconciledJob, state: 'reconciled', duplicate: false },
    );
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      const lock = await pool.connect();
      try {
        await lock.query('begin');
        await lock.query('select id from telegram_outbound_ownership_jobs where id = $1 for update', [ownedJob]);
        const recovered = await telegramRpc<CompletionLeaseItems>(
          client,
          'telegram_lease_outbound_completion($1,$2,$3)',
          [WORKER_B, 2, 60_000],
        );
        const reconciledRecovery = recovered.items[0];
        assert.ok(reconciledRecovery);
        assert.ok(Date.parse(reconciledRecovery.lease_expires_at) > Date.now());
        assert.deepEqual({
          id: reconciledRecovery.id,
          chat_id: reconciledRecovery.chat_id,
          domain_kind: reconciledRecovery.domain_kind,
          domain_id: reconciledRecovery.domain_id,
          state: reconciledRecovery.state,
          telegram_message_id: reconciledRecovery.telegram_message_id,
        }, {
          id: reconciledJob,
          chat_id: -2001,
          domain_kind: 'market_card',
          domain_id: 'market:reconciled-recovery',
          state: 'reconciled',
          telegram_message_id: 602,
        });
        await lock.query('rollback');
      } finally {
        lock.release();
      }
    } finally {
      await pool.end();
    }

    const ownedRecovery = await telegramRpc<CompletionLeaseItems>(
      client,
      'telegram_lease_outbound_completion($1,$2,$3)',
      [WORKER_B, 2, 60_000],
    );
    const ownedCompletion = ownedRecovery.items[0];
    assert.ok(ownedCompletion);
    assert.ok(Date.parse(ownedCompletion.lease_expires_at) > Date.now());
    assert.deepEqual({
      id: ownedCompletion.id,
      chat_id: ownedCompletion.chat_id,
      domain_kind: ownedCompletion.domain_kind,
      domain_id: ownedCompletion.domain_id,
      state: ownedCompletion.state,
      telegram_message_id: ownedCompletion.telegram_message_id,
    }, {
      id: ownedJob,
      chat_id: -2001,
      domain_kind: 'market_card',
      domain_id: 'market:owned-recovery',
      state: 'owned',
      telegram_message_id: 601,
    });
    assert.deepEqual(
      await telegramRpc(client, 'telegram_complete_outbound($1,$2)', [reconciledJob, WORKER_A]),
      { ok: false, code: 'lease_lost' },
    );
    assert.deepEqual(
      await telegramRpc(client, 'telegram_complete_outbound($1,$2)', [reconciledJob, WORKER_B]),
      { ok: true, id: reconciledJob, state: 'complete', duplicate: false },
    );
    const provenance = await client.query<{
      readonly state: string;
      readonly owned_at: string | null;
      readonly uncertain_at: string | null;
      readonly reconciled_at: string | null;
      readonly ownership_source: string;
    }>(
      `select j.state, j.owned_at, j.uncertain_at, j.reconciled_at, m.ownership_source
       from telegram_outbound_ownership_jobs j
       join engine_owned_messages m on m.outbound_job_id = j.id
       where j.id = $1`,
      [reconciledJob],
    );
    const reconciledProvenance = provenance.rows[0];
    assert.ok(reconciledProvenance);
    assert.equal(reconciledProvenance.state, 'complete');
    assert.equal(reconciledProvenance.owned_at, null);
    assert.notEqual(reconciledProvenance.uncertain_at, null);
    assert.notEqual(reconciledProvenance.reconciled_at, null);
    assert.equal(reconciledProvenance.ownership_source, 'reconciled');
  });
  recordEvidence('skip-locked owned and reconciled completion recovery');
});

test('honors terminal retention boundaries and permits service-role RPC access only', async () => {
  const migrations = await discoverMigrationFiles('packages/db/migrations');
  await withMigratedTelegramDb(migrations, async (client) => {
    const completed = await persistTelegramUpdate(client, 203, 'msg:-2001:203', 'pending_engine');
    await telegramRpc(client, 'telegram_lease_updates($1,$2,$3)', [WORKER_A, 1, 60_000]);
    await telegramRpc(client, 'telegram_complete_update($1,$2)', [completed.id, WORKER_A]);
    const routed = await persistTelegramUpdate(client, 204, 'msg:-2001:204', 'routed_concierge');
    const dead = await persistTelegramUpdate(client, 205, 'msg:-2001:205', 'pending_engine');
    await telegramRpc(client, 'telegram_lease_updates($1,$2,$3)', [WORKER_A, 1, 60_000]);
    await telegramRpc(client, 'telegram_dead_letter_update($1,$2,$3)', [dead.id, WORKER_A, 'permanent_failure']);

    await client.query(
      `update telegram_updates
       set completed_at = case when id = $1 then clock_timestamp() - interval '6 days 23 hours' else completed_at end,
           routed_at = case when id = $2 then clock_timestamp() - interval '6 days 23 hours' else routed_at end
       where id in ($1, $2)`,
      [completed.id, routed.id],
    );
    assert.equal((await telegramRpc(client, 'telegram_prune_delivery($1)', [20])).purged_payloads, 0);

    await client.query(
      `update telegram_updates
       set completed_at = case when id = $1 then clock_timestamp() - interval '7 days 1 second' else completed_at end,
           routed_at = case when id = $2 then clock_timestamp() - interval '7 days 1 second' else routed_at end
       where id in ($1, $2)`,
      [completed.id, routed.id],
    );
    assert.equal((await telegramRpc(client, 'telegram_prune_delivery($1)', [20])).purged_payloads, 2);
    const terminalPayloads = await client.query<{ readonly id: string; readonly payload: unknown }>(
      'select id, payload from telegram_updates where id in ($1, $2, $3) order by id',
      [completed.id, routed.id, dead.id],
    );
    assert.equal(terminalPayloads.rows.filter((row) => row.payload === null).length, 2);

    await client.query(
      `update telegram_updates
       set completed_at = case when id = $1 then clock_timestamp() - interval '30 days 1 second' else completed_at end,
           routed_at = case when id = $2 then clock_timestamp() - interval '30 days 1 second' else routed_at end,
           dead_at = case when id = $3 then clock_timestamp() - interval '30 days 1 second' else dead_at end
       where id in ($1, $2, $3)`,
      [completed.id, routed.id, dead.id],
    );
    assert.equal((await telegramRpc(client, 'telegram_prune_delivery($1)', [20])).deleted_ingress_rows, 3);

    await client.query('set role authenticated');
    try {
      await assert.rejects(client.query('select * from telegram_updates'), /permission denied|row-level security/);
      await assert.rejects(
        client.query("select telegram_persist_update('denied', repeat('A', 43), 206, 'message', '{}'::jsonb, 'pending_engine')"),
        /permission denied/,
      );
    } finally {
      await client.query('reset role');
    }
    await client.query('set role service_role');
    try {
      const permitted = await telegramRpc<IdResult>(client, 'telegram_persist_update($1,$2,$3,$4,$5::jsonb,$6)', [
        'service-role:206',
        telegramFingerprint(206),
        206,
        'message',
        JSON.stringify({ update_id: 206, message: { message_id: 206, chat: { id: -2001 } } }),
        'pending_engine',
      ]);
      assert.equal(typeof permitted.id, 'string');
    } finally {
      await client.query('reset role');
    }
  });
  recordEvidence('terminal retention and private role boundaries');
});

async function makeUncertain(
  client: import('pg').Client,
  logicalKey: string,
  domainKind: string,
  domainId: string,
): Promise<string> {
  const planned = await telegramRpc<IdResult>(client, 'telegram_plan_outbound($1,$2,$3,$4)', [
    logicalKey,
    -2001,
    domainKind,
    domainId,
  ]);
  await telegramRpc(client, 'telegram_start_outbound($1,$2,$3)', [planned.id, WORKER_A, 60_000]);
  await client.query(
    "update telegram_outbound_ownership_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
    [planned.id],
  );
  assert.deepEqual(await telegramRpc(client, 'telegram_sweep_expired_outbound($1)', [10]), { ok: true, count: 1 });
  return planned.id;
}

async function makeOwned(client: import('pg').Client, logicalKey: string, messageId: number): Promise<string> {
  const planned = await telegramRpc<IdResult>(client, 'telegram_plan_outbound($1,$2,$3,$4)', [
    logicalKey,
    -2001,
    'market_card',
    'market:owned-recovery',
  ]);
  await telegramRpc(client, 'telegram_start_outbound($1,$2,$3)', [planned.id, WORKER_A, 60_000]);
  assert.deepEqual(
    await telegramRpc(client, 'telegram_mark_outbound_owned($1,$2,$3)', [planned.id, WORKER_A, messageId]),
    { ok: true, id: planned.id, state: 'owned', duplicate: false },
  );
  return planned.id;
}

function recordEvidence(name: string): void {
  evidence.push(name);
}
