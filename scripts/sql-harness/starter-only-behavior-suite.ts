import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { discoverMigrationFiles } from './runner.js';
import {
  STARTER,
  balanceLamports,
  enableStarterBudget,
  fundLinkedUser,
  seedMarket,
  stake,
  stakeAmount,
  stateSnapshot,
  withMigratedDb,
} from './starter-grant-support.js';
import { assertSettlementClosureWins } from './starter-only-contract-support.js';

const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/migrations');

export function registerStarterOnlyBehaviorSuite(record: (message: string) => void): void {
  test('starter-only first tap uses the grant for a linked funded user and later strict requests cannot debit balance', async () => {
    const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
    await withMigratedDb(migrations, async (client) => {
      const fixture = await seedMarket(client, { userId: 7110, groupId: -7110 });
      await fundLinkedUser(client, fixture);
      const balanceBefore = await balanceLamports(client, fixture.userId);

      const first = await stake(client, fixture, 'linked-starter-first', true);
      assert.ok(first.ok && 'position_id' in first);
      const firstState = await stateSnapshot(client, fixture);
      assert.equal(await balanceLamports(client, fixture.userId), balanceBefore);
      assert.equal(firstState.positions.length, 1);
      assert.equal(firstState.grants.length, 1);
      assert.deepEqual(firstState.ledger.map((entry) => [entry.kind, entry.lamports]), [
        ['deposit', '200000000'],
        ['starter_grant', String(STARTER)],
        ['stake', String(-STARTER)],
      ]);

      assert.deepEqual(await stake(client, fixture, 'linked-starter-first', true), { ok: true, duplicate: true });
      assert.deepEqual(await stateSnapshot(client, fixture), firstState);
      assert.deepEqual(await stake(client, fixture, 'linked-starter-second', true), { ok: false, code: 'starter_unavailable' });
      assert.deepEqual(await stateSnapshot(client, fixture), firstState);
      assert.equal(await balanceLamports(client, fixture.userId), balanceBefore);

      const wrongAmount = await seedMarket(client, { userId: 7113, groupId: -7113 });
      await fundLinkedUser(client, wrongAmount);
      const wrongAmountBefore = await stateSnapshot(client, wrongAmount);
      assert.deepEqual(await stakeAmount(client, wrongAmount, {
        key: 'strict-funded',
        lamports: 50_000_000,
        starterOnly: true,
      }), { ok: false, code: 'starter_unavailable' });
      assert.deepEqual(await stateSnapshot(client, wrongAmount), wrongAmountBefore);
    });
    record('linked funded first strict tap used a net-zero starter; replay deduped; distinct and non-0.01 strict calls refused without ordinary balance debit');
  });

  test('settlement closure holding the market row wins before a starter-only stake can commit', async () => {
    const migrations = await discoverMigrationFiles(MIGRATIONS_DIR);
    await withMigratedDb(migrations, async (client, url) => {
      const fixture = await seedMarket(client, { userId: 7291, groupId: -7291 });
      await enableStarterBudget(client);
      await assertSettlementClosureWins(client, url, fixture);
    });
    record('stake waited on settlement market lock, observed closure after commit, and wrote no position, grant, ledger, or budget mutation');
  });
}
