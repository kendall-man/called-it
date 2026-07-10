import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { discoverMigrationFiles } from './sql-harness/runner.js';
import { validateCalledItSchema } from './sql-harness/schema-checks.js';
import {
  STARTER,
  assertBudgetParity,
  assertHappyState,
  assertInjectedExceptionRollsBack,
  assertNoWriteCode,
  assertNoWriteStateCode,
  assertPrivileges,
  counts,
  enableStarterBudget,
  fundLinkedUser,
  poolStake,
  seedMarket,
  stake,
  stateSnapshot,
  withMigratedDb,
} from './sql-harness/starter-grant-support.js';

const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/migrations');
const TAP_PATH = join(process.cwd(), '.omo/evidence/task-7-called-it-direct-onboarding-remediation.sql.tap');
const tapLines: string[] = ['TAP version 13'];
let tapCount = 0;

test.after(async () => {
  tapLines.push(`1..${tapCount}`);
  await mkdir(dirname(TAP_PATH), { recursive: true });
  await writeFile(TAP_PATH, `${tapLines.join('\n')}\n`);
});

test('starter-grant migrations apply fresh and as 0001-0003 upgrade', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async () => undefined);
  record('fresh 0001-0004 migration applied and cleaned');
  await withMigratedDb(migrations.filter((migration) => migration.name <= '0003_broker_pivot.sql'), async (client) => {
    const fourth = migrations.find((migration) => migration.name === '0004_starter_grant.sql');
    assert.ok(fourth);
    await client.query(fourth.sql);
    await validateCalledItSchema(client);
  });
  record('upgraded 0001-0003 plus 0004 applied and cleaned');
});

test('starter stake writes exact linked rows, accepts pending_lineup, and is idempotent and private', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async (client, url) => {
    const fixture = await seedMarket(client, { userId: 7101, groupId: -7101 });
    await enableStarterBudget(client);
    const first = await stake(client, fixture, 'happy', true);
    assert.ok(first.ok && 'position_id' in first);
    await assertHappyState(client, fixture, first.position_id, 'happy', 1);
    for (let replay = 0; replay < 10; replay += 1) {
      assert.deepEqual(await stake(client, fixture, 'happy', true), { ok: true, duplicate: true });
    }
    await assertHappyState(client, fixture, first.position_id, 'happy', 1);

    const pending = await seedMarket(client, { userId: 7102, groupId: -7102 });
    await client.query("update markets set status = 'pending_lineup' where id = $1", [pending.marketId]);
    const pendingResult = await stake(client, pending, 'pending', true);
    assert.ok(pendingResult.ok && 'position_id' in pendingResult);
    await assertHappyState(client, pending, pendingResult.position_id, 'pending', 2);
    await assertPrivileges(client, url);
    await assertBudgetParity(client);
  });
  record('open and pending_lineup wrote exact linked position, +/-10000000 ledger, grant and budget rows; ten replays deduped; privileges enforced');
});

test('every starter refusal and injected exception preserves the exact prior state', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async (client) => {
    await assertNoWriteCode(client, { code: 'starter_unavailable', mutate: async () => undefined });
    await assertNoWriteCode(client, { code: 'paused', mutate: async (c) => {
      await enableStarterBudget(c);
      await c.query('update wager_status set paused = true where id = 1');
    } });
    for (const status of ['frozen', 'settling', 'settled', 'voided'] as const) {
      await assertNoWriteCode(client, { code: 'closed', mutate: async (c, fixture) => {
        await enableStarterBudget(c);
        await c.query('update markets set status = $1 where id = $2', [status, fixture.marketId]);
      } });
    }
    for (const state of ['void', 'closed'] as const) {
      await assertNoWriteStateCode(client, state);
    }
    await assertNoWriteCode(client, { code: 'closed', mutate: async (c, fixture) => {
      await enableStarterBudget(c);
      await c.query("update markets set currency = 'rep' where id = $1", [fixture.marketId]);
    } });
    await assertNoWriteCode(client, { code: 'wallet_required', mutate: async (c, fixture) => {
      await enableStarterBudget(c);
      await c.query('insert into wager_ledger_entries (user_id, kind, lamports, idempotency_key) values ($1, $2, $3, $4)', [fixture.userId, 'deposit', 1, `history:${fixture.userId}`]);
    } });
    await assertNoWriteCode(client, { code: 'wrong_side', mutate: async (c, fixture) => {
      await fundLinkedUser(c, fixture);
      await c.query('insert into positions (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms) values ($1, $2, $3, $4, $5, $6, $7)', [fixture.marketId, fixture.userId, 'doubt', 1, 2, 'active', 1]);
    }, allowStarter: false });
    await assertNoWriteCode(client, { code: 'cap', mutate: async (c, fixture) => {
      await fundLinkedUser(c, fixture);
      await c.query('insert into positions (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms) values ($1, $2, $3, $4, $5, $6, $7)', [fixture.marketId, fixture.userId, 'back', 95_000_001, 2, 'active', 1]);
    }, allowStarter: false });
    await assertInjectedExceptionRollsBack(client);
  });
  record('disabled paused frozen settling settled voided bad-state wrong-side non-SOL history cap and injected exception returned stable codes with exact before/after state');
});

test('concurrency grants once per user and the real 501st eligible user is refused', async () => {
  const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
  await withMigratedDb(migrations, async (client, url) => {
    const same = await seedMarket(client, { userId: 7301, groupId: -7301 });
    await enableStarterBudget(client);
    const pool = new Pool({ connectionString: url, max: 12 });
    try {
      const sameResults = await Promise.all(Array.from({ length: 50 }, () => poolStake(pool, same, 'race-same')));
      const sameSuccess = sameResults.find((result) => result.ok && !('duplicate' in result));
      assert.ok(sameSuccess?.ok && 'position_id' in sameSuccess);
      assert.equal(sameResults.filter((result) => result.ok && 'duplicate' in result).length, 49);
      await assertHappyState(client, same, sameSuccess.position_id, 'race-same', 1);

      const distinct = await seedMarket(client, { userId: 7302, groupId: -7302 });
      const two = await Promise.all([poolStake(pool, distinct, 'race-a'), poolStake(pool, distinct, 'race-b')]);
      const distinctSuccess = two.find((result) => result.ok);
      assert.ok(distinctSuccess?.ok && 'position_id' in distinctSuccess);
      assert.equal(two.filter((result) => !result.ok && result.code === 'wallet_required').length, 1);
      assert.equal((await counts(client, distinct)).positions, 1);
    } finally {
      await pool.end();
    }

    for (let index = 0; index < 498; index += 1) {
      const userId = 7400 + index;
      const fixture = await seedMarket(client, { userId, groupId: -userId });
      const result = await stake(client, fixture, `fill-${index}`, true);
      assert.ok(result.ok && 'position_id' in result);
    }
    await assertBudgetParity(client);
    const exhausted = await seedMarket(client, { userId: 7999, groupId: -7999 });
    const before = await stateSnapshot(client, exhausted);
    assert.deepEqual(await stake(client, exhausted, 'exhausted', true), { ok: false, code: 'budget_exhausted' });
    assert.deepEqual(await stateSnapshot(client, exhausted), before);
    assert.deepEqual(await counts(client, exhausted), { positions: 0, ledger: 0, grants: 0, budgetCount: 500, budgetAmount: '5000000000' });
  });
  record('50 same-key calls produced one exact position; distinct first taps produced success plus wallet_required; 500 real grants remained in parity and the 501st wrote nothing');
});

function record(message: string): void {
  tapCount += 1;
  tapLines.push(`ok ${tapCount} - ${message}`);
}
