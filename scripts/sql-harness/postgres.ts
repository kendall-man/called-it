import { Client, type QueryResult, type QueryResultRow } from 'pg';

export const REQUIRED_ROLES = ['anon', 'authenticated', 'service_role'] as const;
export type RequiredRole = (typeof REQUIRED_ROLES)[number];

export async function withPgClient<T>(
  connectionString: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export function connectionStringForDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function ensureRequiredRoles(admin: Client): Promise<readonly RequiredRole[]> {
  const created: RequiredRole[] = [];
  for (const role of REQUIRED_ROLES) {
    const result = await admin.query<{ exists: boolean }>(
      'select exists(select 1 from pg_roles where rolname = $1) as exists',
      [role],
    );
    if (firstRow(result).exists) {
      continue;
    }
    await admin.query(`create role ${role}`);
    created.push(role);
  }
  return created;
}

export async function dropCreatedRoles(
  admin: Client,
  roles: readonly RequiredRole[],
): Promise<void> {
  for (const role of [...roles].reverse()) {
    await admin.query(`drop role if exists ${role}`);
  }
}

function firstRow<T extends QueryResultRow>(result: QueryResult<T>): T {
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('PostgreSQL query returned no rows');
  }
  return row;
}
