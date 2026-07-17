import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type MigrationFile = {
  readonly name: string;
  readonly path: string;
  readonly sql: string;
};

export interface AdminConnection {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

export type SqlHarnessOptions = {
  readonly admin: AdminConnection;
  readonly migrationFiles: readonly MigrationFile[];
  readonly databaseName: string;
  readonly prepareDatabase?: (databaseName: string) => Promise<void>;
  readonly applyMigration: (migration: MigrationFile, databaseName: string) => Promise<void>;
  readonly validateSchema: (databaseName: string) => Promise<void>;
};

const SAFE_DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function createDisposableDatabase(): string {
  return `calledit_ci_${randomUUID().replaceAll('-', '_')}`;
}

export async function discoverMigrationFiles(directory: string): Promise<readonly MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    sqlFiles.map(async (name) => {
      const path = join(directory, name);
      return { name, path, sql: await readFile(path, 'utf8') };
    }),
  );
}

export async function runSqlHarness(options: SqlHarnessOptions): Promise<void> {
  const databaseName = assertSafeDatabaseName(options.databaseName);
  await options.admin.query(`create database ${databaseName}`);
  try {
    await options.prepareDatabase?.(databaseName);
    for (const migration of options.migrationFiles) {
      await options.applyMigration(migration, databaseName);
    }
    await options.validateSchema(databaseName);
  } finally {
    await options.admin.query(`drop database if exists ${databaseName} with (force)`);
  }
}

function assertSafeDatabaseName(databaseName: string): string {
  if (!SAFE_DATABASE_NAME.test(databaseName)) {
    throw new Error(`unsafe disposable database name: ${databaseName}`);
  }
  return databaseName;
}
