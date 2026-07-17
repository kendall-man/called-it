import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { withPgClient } from './sql-harness/postgres.js';
import { discoverMigrationFiles } from './sql-harness/runner.js';
import {
  backlog,
  completeJob,
  deadLetterJob,
  enqueueJob,
  insertWagerMarker,
  jobSnapshot,
  leaseJobs,
  markSettlementPosted,
  recordTerminalSettlement,
  recordProofState,
  reconcileTerminalJobs,
  retryJob,
  seedTerminalSolMarket,
  SETTLEMENT_PROOF_MIGRATION_NAME,
  terminalGaps,
  withMigratedSettlementProofDb,
} from './sql-harness/settlement-proof-jobs-support.js';

const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/migrations');
const T0 = '2026-07-11T12:00:00.000Z';
const T0_PLUS_499_MS = '2026-07-11T12:00:00.499Z';
const T0_PLUS_500_MS = '2026-07-11T12:00:00.500Z';
const T0_PLUS_1_S = '2026-07-11T12:00:01.000Z';
const T0_PLUS_29_999_MS = '2026-07-11T12:00:29.999Z';
const T0_PLUS_30_S = '2026-07-11T12:00:30.000Z';
const T0_PLUS_30_001_MS = '2026-07-11T12:00:30.001Z';
const T0_PLUS_30_501_MS = '2026-07-11T12:00:30.501Z';
const WORKER_A = 'worker-a';
const WORKER_B = 'worker-b';
const WORKER_C = 'worker-c';

test('applies settlement proof jobs fresh and as a lexically prior upgrade', async () => {
  // Given all tracked migrations and a lexically prior database
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  const migration = migrations.find((candidate) => candidate.name === SETTLEMENT_PROOF_MIGRATION_NAME);
  assert.ok(migration, `missing ${SETTLEMENT_PROOF_MIGRATION_NAME}`);

  // When the migration is applied in both supported paths
  await withMigratedSettlementProofDb(migrations, async (client) => {
    const result = await client.query<{ readonly regclass: string | null }>(
      "select to_regclass('public.settlement_proof_jobs')::text as regclass",
    );
    assert.equal(result.rows[0]?.regclass, 'settlement_proof_jobs');
    const gaps = await client.query('select * from settlement_terminal_gaps($1)', [100]);
    assert.deepEqual(gaps.rows, []);
  });
  await withMigratedSettlementProofDb(
    migrations.filter((candidate) => candidate.name < SETTLEMENT_PROOF_MIGRATION_NAME),
    async (client) => {
      await client.query(migration.sql);
      const result = await client.query<{ readonly count: string }>(
        "select count(*)::text as count from pg_proc where proname = 'settlement_proof_lease'",
      );
      assert.equal(result.rows[0]?.count, '1');
    },
  );

  // Then the durable private surface exists in both cases
});

test('records a terminal settlement, exact replay, and one durable settlement job atomically', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    // Given an open SOL market whose trust tier is chain-proven
    const fixture = await seedTerminalSolMarket(client);

    // When the terminal writer is called and exactly replayed
    const first = await recordTerminalSettlement(client, fixture.marketId, T0);
    const replay = await recordTerminalSettlement(client, fixture.marketId, T0);

    // Then market, immutable fact, and durable job are committed together
    assert.deepEqual(first, {
      ok: true,
      duplicate: false,
      market_id: fixture.marketId,
      job_status: 'pending',
    });
    assert.deepEqual(replay, {
      ok: true,
      duplicate: true,
      market_id: fixture.marketId,
      job_status: 'pending',
    });
    const rows = await client.query<{
      readonly status: string;
      readonly outcome: string;
      readonly tier: string;
      readonly job_kind: string;
      readonly job_status: string;
    }>(
      `select m.status, s.outcome, s.tier, j.job_kind, j.status as job_status
       from markets m
       join settlements s on s.market_id = m.id
       join settlement_proof_jobs j on j.market_id = m.id
       where m.id = $1`,
      [fixture.marketId],
    );
    assert.deepEqual(rows.rows, [{
      status: 'settled',
      outcome: 'claim_won',
      tier: 'chain_proven',
      job_kind: 'settlement',
      job_status: 'pending',
    }]);
  });
});

test('repairs an exact terminal settlement replay by creating only its missing job', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    // Given a legacy terminal market with the exact immutable settlement fact but no job
    const fixture = await seedTerminalSolMarket(client, { status: 'settled' });
    await client.query(
      `insert into settlements (market_id, outcome, deciding_seq, evidence_seqs, tier, settled_at)
       values ($1, 'claim_won', 10, array[8,9,10]::bigint[], 'chain_proven', $2)`,
      [fixture.marketId, T0],
    );

    // When the terminal writer is replayed with the exact fact
    const replay = await recordTerminalSettlement(client, fixture.marketId, T0);

    // Then it preserves the terminal fact and inserts exactly the durable settlement job
    assert.deepEqual(replay, {
      ok: true,
      duplicate: true,
      market_id: fixture.marketId,
      job_status: 'pending',
    });
    const jobs = await client.query<{ readonly count: string; readonly due_at_matches: boolean }>(
      `select count(*)::text as count, bool_and(due_at = $2) as due_at_matches
       from settlement_proof_jobs
       where market_id = $1 and job_kind = 'settlement'`,
      [fixture.marketId, T0],
    );
    assert.deepEqual(jobs.rows, [{ count: '1', due_at_matches: true }]);
  });
});

test('aborts the upgrade without choosing a legacy duplicate proof winner', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  const migration = migrations.find((candidate) => candidate.name === SETTLEMENT_PROOF_MIGRATION_NAME);
  assert.ok(migration, `missing ${SETTLEMENT_PROOF_MIGRATION_NAME}`);
  await withMigratedSettlementProofDb(
    migrations.filter((candidate) => candidate.name < SETTLEMENT_PROOF_MIGRATION_NAME),
    async (client) => {
      // Given a legacy database with an ambiguous public proof identity
      const fixture = await seedTerminalSolMarket(client);
      await client.query(
        `insert into proofs (market_id, kind, status, verified_at)
         values ($1, 'stat', 'pending', null), ($1, 'stat', 'pending', null)`,
        [fixture.marketId],
      );

      // When the forward-only migration is applied
      await assert.rejects(client.query(migration.sql), /proof_identity_conflict/);
      await client.query('rollback');

      // Then the transaction made no new durable-jobs schema changes
      const table = await client.query<{ readonly regclass: string | null }>(
        "select to_regclass('public.settlement_proof_jobs')::text as regclass",
      );
      assert.equal(table.rows[0]?.regclass, null);
    },
  );
});

test('concurrent enqueue preserves one logical job and its first policy per kind', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client, url) => {
    // Given terminal SOL facts without the logical job being enqueued
    const settlementFixture = await seedTerminalSolMarket(client, { status: 'settled' });
    await client.query(
      `insert into settlements (market_id, outcome, deciding_seq, evidence_seqs, tier, settled_at)
       values ($1, 'claim_won', 10, array[8,9,10]::bigint[], 'chain_proven', $2)`,
      [settlementFixture.marketId, T0],
    );
    const proofFixture = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, proofFixture.marketId, T0);
    const policy = { maxAttempts: 3, leaseMs: 31_000, retryBaseMs: 600, retryMaxMs: 31_000 };
    const pool = new Pool({ connectionString: url, max: 20 });

    try {
      // When twenty callers race to enqueue each kind
      const settlementResults = await Promise.all(
        Array.from({ length: 20 }, () => enqueueJob(pool, settlementFixture.marketId, 'settlement', T0_PLUS_1_S, T0, policy)),
      );
      const proofResults = await Promise.all(
        Array.from({ length: 20 }, () => enqueueJob(pool, proofFixture.marketId, 'proof', T0_PLUS_1_S, T0, policy)),
      );

      // Then one row exists per kind and its due/policy never drifted on replay
      assert.equal(settlementResults.filter((result) => result.created === true).length, 1);
      assert.equal(proofResults.filter((result) => result.created === true).length, 1);
      const settlementJob = await jobSnapshot(client, settlementFixture.marketId, 'settlement');
      const proofJob = await jobSnapshot(client, proofFixture.marketId, 'proof');
      for (const row of [settlementJob, proofJob]) {
        assert.equal(row.max_attempts, policy.maxAttempts);
        assert.equal(row.lease_ms, policy.leaseMs);
        assert.equal(row.retry_base_ms, policy.retryBaseMs);
        assert.equal(row.retry_max_ms, policy.retryMaxMs);
        assert.equal(Date.parse(String(row.due_at)), Date.parse(T0_PLUS_1_S));
      }
    } finally {
      await pool.end();
    }
  });
});

test('fences stale workers, recovers expired leases, and survives a restart-equivalent interruption', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client, url) => {
    const policy = { maxAttempts: 3, leaseMs: 30_000, retryBaseMs: 500, retryMaxMs: 30_000 };
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      for (const kind of ['settlement', 'proof'] as const) {
        // Given one durable job that a worker leases before an interruption
        const fixture = await seedTerminalSolMarket(client);
        await recordTerminalSettlement(client, fixture.marketId, T0, { policy });
        if (kind === 'proof') {
          await enqueueJob(client, fixture.marketId, 'proof', T0, T0, policy);
        }
        const first = await leaseJobs(client, kind, WORKER_A, T0);
        const firstJob = first[0];
        assert.ok(firstJob, `missing initial ${kind} lease`);

        // When another worker checks before expiry, then after the persisted expiry
        const concurrent = await Promise.all([
          leaseJobs(pool, kind, WORKER_B, T0_PLUS_29_999_MS),
          leaseJobs(pool, kind, WORKER_C, T0_PLUS_29_999_MS),
        ]);
        assert.deepEqual(concurrent, [[], []]);
        const reclaimed = await leaseJobs(client, kind, WORKER_B, T0_PLUS_30_001_MS);
        const reclaimedJob = reclaimed[0];
        assert.ok(reclaimedJob, `missing reclaimed ${kind} lease`);
        assert.equal(reclaimedJob.attempts, 2);
        assert.notEqual(reclaimedJob.lease_token, firstJob.lease_token);

        // Then every stale-token mutation is fenced, while the new holder can retry idempotently
        assert.deepEqual(
          await completeJob(client, fixture.marketId, kind, WORKER_A, firstJob.lease_token, T0_PLUS_30_001_MS),
          { ok: false, code: 'lease_lost' },
        );
        assert.deepEqual(
          await retryJob(client, fixture.marketId, kind, WORKER_A, firstJob.lease_token, 'unexpected_error', 500, T0_PLUS_30_001_MS),
          { ok: false, code: 'lease_lost' },
        );
        assert.deepEqual(
          await deadLetterJob(client, fixture.marketId, kind, WORKER_A, firstJob.lease_token, 'unexpected_error', T0_PLUS_30_001_MS),
          { ok: false, code: 'lease_lost' },
        );
        assert.deepEqual(
          await retryJob(client, fixture.marketId, kind, WORKER_B, reclaimedJob.lease_token, 'unexpected_error', 500, T0_PLUS_30_001_MS),
          { ok: true, status: 'retry_wait', duplicate: false },
        );
        assert.deepEqual(
          await retryJob(client, fixture.marketId, kind, WORKER_B, reclaimedJob.lease_token, 'unexpected_error', 500, T0_PLUS_30_501_MS),
          { ok: true, status: 'retry_wait', duplicate: true },
        );
        const later = await leaseJobs(client, kind, WORKER_C, T0_PLUS_30_501_MS);
        const laterJob = later[0];
        assert.ok(laterJob, `missing later ${kind} lease`);
        assert.deepEqual(
          await retryJob(client, fixture.marketId, kind, WORKER_B, reclaimedJob.lease_token, 'unexpected_error', 500, T0_PLUS_30_501_MS),
          { ok: false, code: 'lease_lost' },
        );
      }
    } finally {
      await pool.end();
    }
  });
});

test('holds retry work until its injected due time and dead-letters it at the attempt bound', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    // Given a two-attempt settlement job
    const fixture = await seedTerminalSolMarket(client);
    const policy = { maxAttempts: 2, leaseMs: 30_000, retryBaseMs: 500, retryMaxMs: 30_000 };
    await recordTerminalSettlement(client, fixture.marketId, T0, { policy });
    const first = (await leaseJobs(client, 'settlement', WORKER_A, T0))[0];
    assert.ok(first);

    // When the first attempt retries and the second reaches the bound
    assert.deepEqual(
      await retryJob(client, fixture.marketId, 'settlement', WORKER_A, first.lease_token, 'wager_apply_failed', 500, T0),
      { ok: true, status: 'retry_wait', duplicate: false },
    );
    assert.deepEqual(await leaseJobs(client, 'settlement', WORKER_B, T0_PLUS_499_MS), []);
    const second = (await leaseJobs(client, 'settlement', WORKER_B, T0_PLUS_500_MS))[0];
    assert.ok(second);
    assert.equal(second.attempts, 2);
    assert.deepEqual(
      await retryJob(client, fixture.marketId, 'settlement', WORKER_B, second.lease_token, 'wager_apply_failed', 1_000, T0_PLUS_500_MS),
      { ok: true, status: 'dead', duplicate: false },
    );

    // Then replay returns the original dead result and dead work never leases again
    assert.deepEqual(
      await retryJob(client, fixture.marketId, 'settlement', WORKER_B, second.lease_token, 'wager_apply_failed', 1_000, T0_PLUS_1_S),
      { ok: true, status: 'dead', duplicate: true },
    );
    assert.deepEqual(await leaseJobs(client, 'settlement', WORKER_C, T0_PLUS_1_S), []);
  });
});

test('terminalizes an expired final attempt before leasing healthy work', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    // Given a final settlement attempt whose durable graph is already complete
    const finalFixture = await seedTerminalSolMarket(client);
    const finalPolicy = { maxAttempts: 1, leaseMs: 30_000, retryBaseMs: 500, retryMaxMs: 30_000 };
    await recordTerminalSettlement(client, finalFixture.marketId, T0, { policy: finalPolicy });
    await enqueueJob(client, finalFixture.marketId, 'proof', T0, T0, finalPolicy);
    await insertWagerMarker(client, finalFixture.marketId, T0);
    await markSettlementPosted(client, finalFixture.marketId, T0);
    const finalLease = (await leaseJobs(client, 'settlement', WORKER_A, T0))[0];
    assert.ok(finalLease);

    const healthyFixture = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, healthyFixture.marketId, T0);

    // When the next sweep observes expiry
    const healthyLease = (await leaseJobs(client, 'settlement', WORKER_B, T0_PLUS_30_S))[0];

    // Then the final row is completed and the healthy row receives the only new lease
    assert.ok(healthyLease);
    assert.equal(healthyLease.market_id, healthyFixture.marketId);
    assert.equal((await jobSnapshot(client, finalFixture.marketId, 'settlement')).status, 'complete');
  });
});

test('materializes a failed public proof for an expired final proof attempt before leasing healthy work', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    // Given a final proof attempt with no public proof state and a second healthy proof job
    const finalFixture = await seedTerminalSolMarket(client);
    const finalPolicy = { maxAttempts: 1, leaseMs: 30_000, retryBaseMs: 500, retryMaxMs: 30_000 };
    await recordTerminalSettlement(client, finalFixture.marketId, T0, { policy: finalPolicy });
    await enqueueJob(client, finalFixture.marketId, 'proof', T0, T0, finalPolicy);
    assert.ok((await leaseJobs(client, 'proof', WORKER_A, T0))[0]);
    const healthyFixture = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, healthyFixture.marketId, T0);
    await enqueueJob(client, healthyFixture.marketId, 'proof', T0, T0);

    // When the next sweep observes the final expiry
    const healthyLease = (await leaseJobs(client, 'proof', WORKER_B, T0_PLUS_30_S))[0];

    // Then the expired row has an honest terminal public proof and does not block healthy work
    assert.ok(healthyLease);
    assert.equal(healthyLease.market_id, healthyFixture.marketId);
    assert.equal((await jobSnapshot(client, finalFixture.marketId, 'proof')).status, 'dead');
    const proof = await client.query<{ readonly status: string }>(
      "select status from proofs where market_id = $1 and kind = 'stat'",
      [finalFixture.marketId],
    );
    assert.deepEqual(proof.rows, [{ status: 'failed' }]);
  });
});

test('isolates poison proof work from a second proof that completes in the same sweep', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    // Given two due proof jobs
    const poisonFixture = await seedTerminalSolMarket(client);
    const healthyFixture = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, poisonFixture.marketId, T0);
    await recordTerminalSettlement(client, healthyFixture.marketId, T0);
    await enqueueJob(client, poisonFixture.marketId, 'proof', T0, T0);
    await enqueueJob(client, healthyFixture.marketId, 'proof', T0, T0);
    const leases = await leaseJobs(client, 'proof', WORKER_A, T0, 2);
    assert.equal(leases.length, 2);
    const poisonLease = leases.find((lease) => lease.market_id === poisonFixture.marketId);
    const healthyLease = leases.find((lease) => lease.market_id === healthyFixture.marketId);
    assert.ok(poisonLease);
    assert.ok(healthyLease);

    // When one public proof becomes failed and the other is verified
    await recordProofState(client, poisonFixture.marketId, 'pending', T0);
    await recordProofState(client, poisonFixture.marketId, 'failed', T0);
    await recordProofState(client, healthyFixture.marketId, 'pending', T0);
    await recordProofState(client, healthyFixture.marketId, 'verified', T0);
    const poison = await deadLetterJob(client, poisonFixture.marketId, 'proof', WORKER_A, poisonLease.lease_token, 'proof_verify_failed', T0);
    const healthy = await completeJob(client, healthyFixture.marketId, 'proof', WORKER_A, healthyLease.lease_token, T0);

    // Then poison is terminally public and dead without blocking the healthy completion
    assert.deepEqual(poison, { ok: true, status: 'dead', duplicate: false });
    assert.deepEqual(healthy, { ok: true, status: 'complete', duplicate: false });
    assert.equal((await jobSnapshot(client, poisonFixture.marketId, 'proof')).status, 'dead');
    assert.equal((await jobSnapshot(client, healthyFixture.marketId, 'proof')).status, 'complete');
  });
});

test('finds independent terminal gaps and reconciles only missing durable jobs', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    // Given fixtures independently missing the settlement, marker, proof job/proof state, and chat marker
    const missingSettlement = await seedTerminalSolMarket(client, { status: 'settled' });
    const missingMarker = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, missingMarker.marketId, T0);
    const missingTerminalProof = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, missingTerminalProof.marketId, T0);
    await enqueueJob(client, missingTerminalProof.marketId, 'proof', T0, T0);
    await insertWagerMarker(client, missingTerminalProof.marketId, T0);
    await markSettlementPosted(client, missingTerminalProof.marketId, T0);
    const missingChatPost = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, missingChatPost.marketId, T0);
    await enqueueJob(client, missingChatPost.marketId, 'proof', T0, T0);
    await insertWagerMarker(client, missingChatPost.marketId, T0);
    await recordProofState(client, missingChatPost.marketId, 'pending', T0);
    await recordProofState(client, missingChatPost.marketId, 'verified', T0);

    // When operations inspect and reconcile the terminal graph twice
    const gaps = await terminalGaps(client, 100);
    const byMarket = new Map(gaps.map((gap) => [String(gap.market_id), gap]));
    const first = await reconcileTerminalJobs(client, T0, 100);
    const second = await reconcileTerminalJobs(client, T0_PLUS_1_S, 100);

    // Then every missing-effect class is visible and only missing jobs are created once
    assert.deepEqual(byMarket.get(missingSettlement.marketId), {
      market_id: missingSettlement.marketId,
      settlement_job_missing: true,
      settlement_row_missing: true,
      wager_marker_missing: true,
      proof_job_missing: true,
      proof_terminal_missing: false,
      chat_post_missing: false,
      settlement_terminal_conflict: false,
      proof_terminal_conflict: false,
    });
    assert.equal(byMarket.get(missingMarker.marketId)?.wager_marker_missing, true);
    assert.equal(byMarket.get(missingMarker.marketId)?.proof_job_missing, true);
    assert.equal(byMarket.get(missingMarker.marketId)?.chat_post_missing, true);
    assert.equal(byMarket.get(missingTerminalProof.marketId)?.proof_terminal_missing, true);
    assert.equal(byMarket.get(missingChatPost.marketId)?.chat_post_missing, true);
    assert.equal(byMarket.get(missingChatPost.marketId)?.proof_terminal_missing, false);

    const firstByMarket = new Map(first.map((row) => [String(row.market_id), row]));
    assert.equal(firstByMarket.get(missingSettlement.marketId)?.settlement_job_created, true);
    assert.equal(firstByMarket.get(missingSettlement.marketId)?.proof_job_created, false);
    assert.equal(firstByMarket.get(missingMarker.marketId)?.settlement_job_created, false);
    assert.equal(firstByMarket.get(missingMarker.marketId)?.proof_job_created, true);
    for (const row of second) {
      assert.equal(row.settlement_job_created, false);
      assert.equal(row.proof_job_created, false);
    }
  });
});

test('converges simulated durable effects to one of each identity and zero ready backlog', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    // Given a terminal market with both durable jobs
    const fixture = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, fixture.marketId, T0);
    await enqueueJob(client, fixture.marketId, 'proof', T0, T0);

    // When deterministic money, proof, and chat effects are idempotently persisted
    await insertWagerMarker(client, fixture.marketId, T0);
    await client.query(
      `insert into wager_ledger_entries (user_id, group_id, market_id, kind, lamports, idempotency_key)
       values ($1, $2, $3, 'payout', 1, $4)
       on conflict (idempotency_key) do nothing`,
      [fixture.userId, fixture.groupId, fixture.marketId, `wager:payout:${fixture.marketId}:${fixture.userId}`],
    );
    await client.query(
      `insert into wager_ledger_entries (user_id, group_id, market_id, kind, lamports, idempotency_key)
       values ($1, $2, $3, 'payout', 1, $4)
       on conflict (idempotency_key) do nothing`,
      [fixture.userId, fixture.groupId, fixture.marketId, `wager:payout:${fixture.marketId}:${fixture.userId}`],
    );
    await markSettlementPosted(client, fixture.marketId, T0);
    await recordProofState(client, fixture.marketId, 'pending', T0);
    await recordProofState(client, fixture.marketId, 'verified', T0);
    const settlementLease = (await leaseJobs(client, 'settlement', WORKER_A, T0))[0];
    const proofLease = (await leaseJobs(client, 'proof', WORKER_A, T0))[0];
    assert.ok(settlementLease);
    assert.ok(proofLease);
    assert.deepEqual(
      await completeJob(client, fixture.marketId, 'settlement', WORKER_A, settlementLease.lease_token, T0),
      { ok: true, status: 'complete', duplicate: false },
    );
    assert.deepEqual(
      await completeJob(client, fixture.marketId, 'proof', WORKER_A, proofLease.lease_token, T0),
      { ok: true, status: 'complete', duplicate: false },
    );

    // Then every durable identity is singular and neither queue has ready work
    const counts = await client.query<{
      readonly settlement_jobs: string;
      readonly proof_jobs: string;
      readonly proof_rows: string;
      readonly markers: string;
      readonly ledger_rows: string;
    }>(
      `select
         (select count(*)::text from settlement_proof_jobs where market_id = $1 and job_kind = 'settlement') as settlement_jobs,
         (select count(*)::text from settlement_proof_jobs where market_id = $1 and job_kind = 'proof') as proof_jobs,
         (select count(*)::text from proofs where market_id = $1 and kind = 'stat') as proof_rows,
         (select count(*)::text from wager_settlements_applied where market_id = $1) as markers,
         (select count(*)::text from wager_ledger_entries where idempotency_key = $2) as ledger_rows`,
      [fixture.marketId, `wager:payout:${fixture.marketId}:${fixture.userId}`],
    );
    assert.deepEqual(counts.rows, [{ settlement_jobs: '1', proof_jobs: '1', proof_rows: '1', markers: '1', ledger_rows: '1' }]);
    assert.deepEqual(await backlog(client, 'settlement', T0), {
      ready_count: 0,
      oldest_ready_age_ms: null,
      active_lease_count: 0,
      retry_wait_count: 0,
      expired_lease_count: 0,
      dead_count: 0,
    });
    assert.deepEqual(await backlog(client, 'proof', T0), {
      ready_count: 0,
      oldest_ready_age_ms: null,
      active_lease_count: 0,
      retry_wait_count: 0,
      expired_lease_count: 0,
      dead_count: 0,
    });
  });
});

test('reports exact ready backlog boundaries while excluding future retry and a valid lease', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    // Given an active lease, expired lease, due pending job, and future retry-wait job
    const activeFixture = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, activeFixture.marketId, T0, {
      policy: { maxAttempts: 8, leaseMs: 90_000, retryBaseMs: 500, retryMaxMs: 30_000 },
    });
    assert.equal((await leaseJobs(client, 'settlement', WORKER_A, T0))[0]?.market_id, activeFixture.marketId);
    const expiredFixture = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, expiredFixture.marketId, T0, {
      policy: { maxAttempts: 8, leaseMs: 1_000, retryBaseMs: 500, retryMaxMs: 30_000 },
    });
    assert.equal((await leaseJobs(client, 'settlement', WORKER_B, T0))[0]?.market_id, expiredFixture.marketId);
    const futureFixture = await seedTerminalSolMarket(client);
    const futurePolicy = { maxAttempts: 8, leaseMs: 30_000, retryBaseMs: 30_000, retryMaxMs: 30_000 };
    await recordTerminalSettlement(client, futureFixture.marketId, T0, { policy: futurePolicy });
    const futureLease = (await leaseJobs(client, 'settlement', WORKER_C, T0))[0];
    assert.ok(futureLease);
    assert.deepEqual(
      await retryJob(client, futureFixture.marketId, 'settlement', WORKER_C, futureLease.lease_token, 'wager_apply_failed', 30_000, T0),
      { ok: true, status: 'retry_wait', duplicate: false },
    );
    const readyFixture = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, readyFixture.marketId, T0);

    // When the injected clock reaches the expired-lease boundary
    const settlementBacklog = await backlog(client, 'settlement', T0_PLUS_1_S);
    const proofBacklog = await backlog(client, 'proof', T0_PLUS_1_S);

    // Then only due pending work and reclaimable expiry are ready, with an exact oldest age
    assert.deepEqual(settlementBacklog, {
      ready_count: 2,
      oldest_ready_age_ms: 1_000,
      active_lease_count: 1,
      retry_wait_count: 1,
      expired_lease_count: 1,
      dead_count: 0,
    });
    assert.deepEqual(proofBacklog, {
      ready_count: 0,
      oldest_ready_age_ms: null,
      active_lease_count: 0,
      retry_wait_count: 0,
      expired_lease_count: 0,
      dead_count: 0,
    });
  });
});

test('enforces terminal fact immutability and allows only exact durable replays', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client) => {
    // Given terminal settlement and verified proof facts
    const fixture = await seedTerminalSolMarket(client);
    await recordTerminalSettlement(client, fixture.marketId, T0);
    await markSettlementPosted(client, fixture.marketId, T0);
    await recordProofState(client, fixture.marketId, 'pending', T0);
    await recordProofState(client, fixture.marketId, 'verified', T0);

    // When callers attempt mutation, deletion, downgrade, rewrite, and exact replay
    await assert.rejects(
      client.query("update settlements set outcome = 'claim_lost' where market_id = $1", [fixture.marketId]),
      /settlement_immutable/,
    );
    await assert.rejects(client.query('delete from settlements where market_id = $1', [fixture.marketId]), /settlement_immutable/);
    await client.query('update settlements set posted_at = posted_at where market_id = $1', [fixture.marketId]);
    await assert.rejects(
      client.query('update settlements set posted_at = $2 where market_id = $1', [fixture.marketId, T0_PLUS_1_S]),
      /settlement_posted_at_immutable/,
    );
    await client.query('update proofs set status = status where market_id = $1 and kind = $2', [fixture.marketId, 'stat']);
    await assert.rejects(
      client.query("update proofs set status = 'pending' where market_id = $1 and kind = 'stat'", [fixture.marketId]),
      /proof_terminal_immutable/,
    );
    await assert.rejects(client.query("delete from proofs where market_id = $1 and kind = 'stat'", [fixture.marketId]), /proof_terminal_immutable/);

    // Then immutable data remains accepted only as an exact replay
    assert.deepEqual(await recordTerminalSettlement(client, fixture.marketId, T0), {
      ok: true,
      duplicate: true,
      market_id: fixture.marketId,
      job_status: 'pending',
    });
    const proofReplay = await recordProofState(client, fixture.marketId, 'verified', T0);
    assert.equal(proofReplay.ok, true);
    assert.equal(proofReplay.duplicate, true);
    assert.equal(proofReplay.market_id, fixture.marketId);
    assert.equal(proofReplay.kind, 'stat');
    assert.equal(proofReplay.status, 'verified');
    assert.equal(Date.parse(String(proofReplay.verified_at)), Date.parse(T0));
  });
});

test('denies direct table and RPC access to public roles while permitting service-role RPCs', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedSettlementProofDb(migrations, async (client, url) => {
    // Given every Task 10 RPC signature on a migrated private table
    const names = [
      'settlement_record_terminal',
      'settlement_mark_posted',
      'proof_record_state',
      'settlement_proof_enqueue',
      'settlement_proof_lease',
      'settlement_proof_complete',
      'settlement_proof_retry',
      'settlement_proof_dead_letter',
      'settlement_terminal_gaps',
      'settlement_reconcile_terminal_jobs',
      'settlement_proof_backlog',
    ];
    const privileges = await client.query<{
      readonly signature: string;
      readonly definer: boolean;
      readonly search_path: readonly string[] | null;
      readonly anon: boolean;
      readonly authenticated: boolean;
      readonly service: boolean;
      readonly public: boolean;
    }>(
      `select
         p.oid::regprocedure::text as signature,
         p.prosecdef as definer,
         p.proconfig as search_path,
         has_function_privilege('anon', p.oid, 'execute') as anon,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
         has_function_privilege('service_role', p.oid, 'execute') as service,
         has_function_privilege('public', p.oid, 'execute') as public
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any($1::text[])
       order by p.oid::regprocedure::text`,
      [names],
    );
    assert.equal(privileges.rows.length, names.length);
    for (const row of privileges.rows) {
      assert.equal(row.definer, true, row.signature);
      assert.ok(row.search_path?.includes('search_path=public'), row.signature);
      assert.equal(row.anon, false, row.signature);
      assert.equal(row.authenticated, false, row.signature);
      assert.equal(row.service, true, row.signature);
      assert.equal(row.public, false, row.signature);
    }

    // When anon/authenticated and service-role clients attempt direct access or RPCs
    for (const role of ['anon', 'authenticated'] as const) {
      await withPgClient(url, async (roleClient) => {
        await roleClient.query(`set role ${role}`);
        try {
          await assert.rejects(roleClient.query('select * from settlement_proof_jobs'), /permission denied|row-level security/);
          await assert.rejects(roleClient.query("select * from settlement_proof_backlog('proof', $1)", [T0]), /permission denied/);
        } finally {
          await roleClient.query('reset role');
        }
      });
    }
    await withPgClient(url, async (roleClient) => {
      await roleClient.query('set role service_role');
      try {
        await assert.rejects(roleClient.query('select * from settlement_proof_jobs'), /permission denied|row-level security/);
        const snapshot = await roleClient.query('select * from settlement_proof_backlog($1,$2)', ['proof', T0]);
        assert.equal(snapshot.rows.length, 1);
      } finally {
        await roleClient.query('reset role');
      }
    });
  });
});
