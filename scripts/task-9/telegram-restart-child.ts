import { Bot } from '../../apps/engine/node_modules/grammy/out/mod.js';
import { Client } from 'pg';

const LEASE_MS = 60_000;
const WORKER_IDS = {
  crash: '00000000-0000-4000-8000-000000000901',
  replay: '00000000-0000-4000-8000-000000000902',
} as const;

type ChildMode = keyof typeof WORKER_IDS;
type ChildStatus =
  | 'effect_committed'
  | 'completed'
  | 'failed_mode'
  | 'failed_database'
  | 'failed_connection'
  | 'failed_lease'
  | 'failed_leased'
  | 'failed_effect';
type FailureStage = 'mode' | 'database' | 'connection' | 'lease' | 'leased' | 'effect';
type GrammYUpdate = Parameters<Bot['handleUpdate']>[0];

type RpcRow<T> = {
  readonly result: T;
};

type LeasedUpdate = {
  readonly id: string;
  readonly source_fingerprint: string;
  readonly payload: GrammYUpdate;
};

type LeaseResult = {
  readonly ok: true;
  readonly items: readonly LeasedUpdate[];
};

type CompletionResult = {
  readonly ok: boolean;
  readonly state?: string;
};

class RestartChildError extends Error {
  readonly name = 'RestartChildError';

  constructor(code: string) {
    super(code);
  }
}

let failureStage: FailureStage = 'mode';

async function run(): Promise<void> {
  const mode = childMode(process.argv[2]);
  failureStage = 'database';
  const connectionString = requiredDatabaseUrl();
  failureStage = 'connection';
  const client = new Client({ connectionString });
  await client.connect();
  try {
    failureStage = 'lease';
    const leased = await leaseUpdate(client, WORKER_IDS[mode]);
    failureStage = 'leased';
    const bot = new Bot('fixture-token', {
      botInfo: {
        id: 905,
        is_bot: true,
        first_name: 'fixture',
        username: 'fixture_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
      },
    });
    bot.use(async (_ctx, next) => {
      await client.query(
        'insert into telegram_restart_domain_effects (source_fingerprint) values ($1) on conflict do nothing',
        [leased.source_fingerprint],
      );
      failureStage = 'effect';
      if (mode === 'crash') {
        await sendStatus('effect_committed');
        await waitForever();
      }
      await next();
    });
    await bot.handleUpdate(leased.payload);
    await completeUpdate(client, leased.id, WORKER_IDS[mode]);
    await sendStatus('completed');
  } finally {
    await client.end();
  }
}

async function leaseUpdate(client: Client, workerId: string): Promise<LeasedUpdate> {
  const result = await client.query<RpcRow<LeaseResult>>(
    'select telegram_lease_updates($1,$2,$3) as result',
    [workerId, 1, LEASE_MS],
  );
  const row = result.rows[0];
  const item = row?.result.items[0];
  if (row === undefined || item === undefined || row.result.items.length !== 1) {
    throw new RestartChildError('expected_one_leased_update');
  }
  return item;
}

async function completeUpdate(client: Client, updateId: string, workerId: string): Promise<void> {
  const result = await client.query<RpcRow<CompletionResult>>(
    'select telegram_complete_update($1,$2) as result',
    [updateId, workerId],
  );
  const completion = result.rows[0]?.result;
  if (completion?.ok !== true || completion.state !== 'completed') {
    throw new RestartChildError('queue_completion_rejected');
  }
}

function childMode(value: string | undefined): ChildMode {
  if (value === 'crash' || value === 'replay') return value;
  throw new RestartChildError('invalid_child_mode');
}

function requiredDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') throw new RestartChildError('database_url_missing');
  return url;
}

function waitForever(): Promise<never> {
  return new Promise(() => undefined);
}

function sendStatus(status: ChildStatus): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new RestartChildError('ipc_unavailable'));
      return;
    }
    process.send(status, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(new RestartChildError('ipc_send_failed'));
      }
    });
  });
}

function disconnect(): void {
  if (process.connected) process.disconnect();
}

function failureStatus(): Extract<ChildStatus, `failed_${string}`> {
  return `failed_${failureStage}`;
}

void run().then(
  () => {
    process.exitCode = 0;
    disconnect();
  },
  () => {
    process.exitCode = 1;
    void sendStatus(failureStatus()).then(disconnect, disconnect);
  },
);
