import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDisposableDatabase,
  discoverMigrationFiles,
  runSqlHarness,
  type AdminConnection,
} from './sql-harness/runner.js';
import {
  withRequiredRoles,
  type RequiredRole,
  type RoleOperations,
} from './sql-harness/postgres.js';

test('discovers tracked SQL migrations in lexical order', async () => {
  // Given a migration directory with SQL files and unrelated files
  const dir = await mkdtemp(join(tmpdir(), 'calledit-sql-discovery-'));
  try {
    await writeFile(join(dir, '0002_second.sql'), 'select 2;');
    await writeFile(join(dir, 'notes.txt'), 'ignore me');
    await writeFile(join(dir, '0001_first.sql'), 'select 1;');

    // When the harness discovers migrations
    const migrations = await discoverMigrationFiles(dir);

    // Then only SQL migrations are returned in application order
    assert.deepEqual(
      migrations.map((migration) => migration.name),
      ['0001_first.sql', '0002_second.sql'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('drops the disposable database when migration application fails', async () => {
  // Given a disposable database and a malformed migration
  const calls: string[] = [];
  const admin: AdminConnection = {
    query: async (sql) => {
      calls.push(sql);
    },
  };

  // When the migration runner fails
  await assert.rejects(
    runSqlHarness({
      admin,
      migrationFiles: [{ name: '0001_bad.sql', path: '/tmp/0001_bad.sql', sql: 'select broken' }],
      databaseName: 'calledit_test_failure',
      applyMigration: async () => {
        throw new Error('migration failed');
      },
      validateSchema: async () => undefined,
    }),
    /migration failed/,
  );

  // Then the disposable database cleanup still runs
  assert.deepEqual(calls, [
    'create database calledit_test_failure',
    'drop database if exists calledit_test_failure with (force)',
  ]);
});

test('creates disposable database names with the expected prefix', () => {
  // Given the SQL harness needs an isolated database name
  const first = createDisposableDatabase();
  const second = createDisposableDatabase();

  // When names are generated
  // Then each name is safe for SQL identifiers and collision-resistant enough for parallel CI
  assert.match(first, /^calledit_ci_[a-z0-9_]+$/);
  assert.match(second, /^calledit_ci_[a-z0-9_]+$/);
  assert.notEqual(first, second);
});

test('cleans partially created roles without dropping pre-existing roles', async () => {
  // Given one pre-existing role and a failure after the harness creates another role
  const existing = new Set<RequiredRole>(['authenticated']);
  const operations: RoleOperations = {
    roleExists: async (role) => existing.has(role),
    createRole: async (role) => {
      if (role === 'service_role') {
        throw new Error('injected role creation failure');
      }
      existing.add(role);
    },
    dropRole: async (role) => {
      existing.delete(role);
    },
  };

  // When required-role setup fails partway through
  await assert.rejects(
    withRequiredRoles(operations, async () => undefined),
    /injected role creation failure/,
  );

  // Then only the role that existed before the harness remains
  assert.deepEqual([...existing], ['authenticated']);
});
