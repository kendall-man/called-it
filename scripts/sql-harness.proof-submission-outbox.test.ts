import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { discoverMigrationFiles } from './sql-harness/runner.js';
import {
  recordProofState,
  recordTerminalSettlement,
  rpc,
  seedTerminalSolMarket,
  withMigratedSettlementProofDb,
} from './sql-harness/settlement-proof-jobs-support.js';

const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/migrations');
const OUTBOX_MIGRATION_NAME = '0010_proof_submission_outbox.sql';
const T0 = '2026-07-12T12:00:00.000Z';
const SIGNATURE_A = 'A'.repeat(64);
const SIGNATURE_B = 'B'.repeat(64);
const RAW_A = 'QUJDREVGR0gx';
const RAW_B = 'QUJDREVGR0gy';
const PROOF = { summary: { updateStats: { minTimestamp: 1_752_000_000_000 } } };

test('applies proof submission outbox migration fresh and from its lexical predecessor', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  const migration = migrations.find((candidate) => candidate.name === OUTBOX_MIGRATION_NAME);
  assert.ok(migration, `missing ${OUTBOX_MIGRATION_NAME}`);

  await withMigratedSettlementProofDb(migrations, async (client) => {
    const relation = await client.query<{ readonly relation: string | null }>(
      "select to_regclass('public.proof_submission_outbox')::text as relation",
    );
    assert.equal(relation.rows[0]?.relation, 'proof_submission_outbox');
  });
  await withMigratedSettlementProofDb(
    migrations.filter((candidate) => candidate.name < OUTBOX_MIGRATION_NAME),
    async (client) => {
      await client.query(migration.sql);
      const functions = await client.query<{ readonly count: string }>(
        "select count(*)::text as count from pg_proc where proname like 'proof_submission_%'",
      );
      assert.equal(functions.rows[0]?.count, '5');
    },
  );
});

test('persists exact signed bytes before broadcast and replays the same durable identity', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    const fixture = await readyForSubmission(client);

    // This is the SIGKILL boundary: prepare has committed, but no RPC send occurred.
    const prepared = await prepare(client, fixture.marketId, SIGNATURE_A, RAW_A, 500);
    assert.equal(prepared.ok, true);
    const replay = await prepare(client, fixture.marketId, SIGNATURE_A, RAW_A, 500);
    assert.deepEqual(replay, { ...prepared, duplicate: true });

    const rows = await client.query<{
      readonly attempt: number;
      readonly state: string;
      readonly signature: string;
      readonly raw_tx_b64: string;
      readonly last_valid_block_height: string;
      readonly broadcast_count: number;
    }>(
      `select attempt, state, signature, raw_tx_b64, last_valid_block_height::text, broadcast_count
       from proof_submission_outbox where market_id = $1`,
      [fixture.marketId],
    );
    assert.deepEqual(rows.rows, [{
      attempt: 1,
      state: 'prepared',
      signature: SIGNATURE_A,
      raw_tx_b64: RAW_A,
      last_valid_block_height: '500',
      broadcast_count: 0,
    }]);
  });
});

test('recovers a sent transaction by durable signature status before terminal proof verification', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    const fixture = await readyForSubmission(client);
    await prepare(client, fixture.marketId, SIGNATURE_A, RAW_A, 500);

    // Simulate a send that completed before the worker process could update local job state.
    const broadcast = await transition(client, 'proof_submission_mark_broadcast', fixture.marketId, 1, SIGNATURE_A);
    assert.equal(broadcast.ok, true);
    const recovered = await rpc(client, 'proof_submission_get($1)', [fixture.marketId]);
    assert.equal(recovered.ok, true);
    assert.deepEqual(recovered.outbox, broadcast.outbox);

    // A restarted worker status-checks this signature, records it landed, then may mark proof verified.
    const landed = await transition(client, 'proof_submission_mark_landed', fixture.marketId, 1, SIGNATURE_A);
    assert.equal(landed.ok, true);
    const proof = await recordProofState(client, fixture.marketId, 'verified', T0);
    assert.equal(proof.ok, true);
    const duplicate = await transition(client, 'proof_submission_mark_landed', fixture.marketId, 1, SIGNATURE_A);
    assert.equal(duplicate.duplicate, true);

    const state = await client.query<{ readonly state: string; readonly raw_tx_b64: string }>(
      'select state, raw_tx_b64 from proof_submission_outbox where market_id = $1 and attempt = 1',
      [fixture.marketId],
    );
    assert.deepEqual(state.rows, [{ state: 'landed', raw_tx_b64: RAW_A }]);
  });
});

test('permits a replacement only after immutable expiry and keeps private signed bytes inaccessible', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    const fixture = await readyForSubmission(client);
    await prepare(client, fixture.marketId, SIGNATURE_A, RAW_A, 500);

    const expired = await transition(client, 'proof_submission_mark_expired', fixture.marketId, 1, SIGNATURE_A);
    assert.equal(expired.ok, true);
    const oldBroadcast = await transition(client, 'proof_submission_mark_broadcast', fixture.marketId, 1, SIGNATURE_A);
    assert.deepEqual(oldBroadcast, { ok: false, code: 'submission_not_active' });
    const replacement = await prepare(client, fixture.marketId, SIGNATURE_B, RAW_B, 600);
    assert.equal(replacement.ok, true);

    const attempts = await client.query<{
      readonly attempt: number;
      readonly state: string;
      readonly signature: string;
    }>(
      'select attempt, state, signature from proof_submission_outbox where market_id = $1 order by attempt',
      [fixture.marketId],
    );
    assert.deepEqual(attempts.rows, [
      { attempt: 1, state: 'expired', signature: SIGNATURE_A },
      { attempt: 2, state: 'prepared', signature: SIGNATURE_B },
    ]);

    await client.query('set role authenticated');
    await assert.rejects(
      client.query('select raw_tx_b64 from proof_submission_outbox'),
      /permission denied/i,
    );
    await client.query('reset role');
  });
});

async function readyForSubmission(client: Parameters<typeof seedTerminalSolMarket>[0]) {
  const fixture = await seedTerminalSolMarket(client);
  await recordTerminalSettlement(client, fixture.marketId, T0);
  const proof = await recordProofState(client, fixture.marketId, 'pending', T0);
  assert.equal(proof.ok, true);
  return fixture;
}

function prepare(
  client: Parameters<typeof seedTerminalSolMarket>[0],
  marketId: string,
  signature: string,
  rawTxB64: string,
  lastValidBlockHeight: number,
) {
  return rpc(
    client,
    'proof_submission_prepare($1,$2,$3,$4,$5::jsonb,$6)',
    [marketId, signature, rawTxB64, lastValidBlockHeight, JSON.stringify(PROOF), T0],
  );
}

function transition(
  client: Parameters<typeof seedTerminalSolMarket>[0],
  name: 'proof_submission_mark_broadcast' | 'proof_submission_mark_landed' | 'proof_submission_mark_expired',
  marketId: string,
  attempt: number,
  signature: string,
) {
  return rpc(client, `${name}($1,$2,$3,$4)`, [marketId, attempt, signature, T0]);
}
