import { Client, type QueryResult, type QueryResultRow } from 'pg';

export const REQUIRED_ROLES = ['anon', 'authenticated', 'service_role'] as const;
export type RequiredRole = (typeof REQUIRED_ROLES)[number];

export type RoleOperations = {
  readonly roleExists: (role: RequiredRole) => Promise<boolean>;
  readonly createRole: (role: RequiredRole) => Promise<void>;
  readonly dropRole: (role: RequiredRole) => Promise<void>;
};

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

export function postgresRoleOperations(admin: Client): RoleOperations {
  return {
    roleExists: async (role) => {
      const result = await admin.query<{ exists: boolean }>(
        'select exists(select 1 from pg_roles where rolname = $1) as exists',
        [role],
      );
      return firstRow(result).exists;
    },
    createRole: async (role) => {
      await admin.query(`create role ${role}`);
    },
    dropRole: async (role) => {
      await admin.query(`drop role if exists ${role}`);
    },
  };
}

export async function withRequiredRoles<T>(
  operations: RoleOperations,
  run: () => Promise<T>,
): Promise<T> {
  const createdRoles: RequiredRole[] = [];
  try {
    for (const role of REQUIRED_ROLES) {
      if (await operations.roleExists(role)) {
        continue;
      }
      await operations.createRole(role);
      createdRoles.push(role);
    }
    return await run();
  } finally {
    await dropCreatedRoles(operations, createdRoles);
  }
}

async function dropCreatedRoles(
  operations: RoleOperations,
  roles: readonly RequiredRole[],
): Promise<void> {
  for (const role of [...roles].reverse()) {
    await operations.dropRole(role);
  }
}

function firstRow<T extends QueryResultRow>(result: QueryResult<T>): T {
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('PostgreSQL query returned no rows');
  }
  return row;
}
