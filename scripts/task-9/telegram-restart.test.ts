import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { discoverMigrationFiles } from '../sql-harness/runner.js';
import { telegramRpc, withMigratedTelegramDb } from '../sql-harness/telegram-ingress-support.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHILD_PATH = fileURLToPath(new URL('./telegram-restart-child.ts', import.meta.url));
const EVIDENCE_PATH = join(REPOSITORY_ROOT, '.omo/evidence/task-9-called-it-direct-onboarding-remediation.txt');
const CHILD_TIMEOUT_MS = 10_000;
const DATABASE_CONFIGURED = Boolean((process.env.DATABASE_URL ?? process.env.POSTGRES_URL)?.trim());
const FIXTURE_FINGERPRINT = 'A'.repeat(43);
const FIXTURE_SOURCE_KEY = 'fixture_restart_source';
const FIXTURE_UPDATE_ID = 901;

type ChildMode = 'crash' | 'replay';
type ChildStatus =
  | 'effect_committed'
  | 'completed'
  | 'failed_mode'
  | 'failed_database'
  | 'failed_connection'
  | 'failed_lease'
  | 'failed_leased'
  | 'failed_effect';

type ChildExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

type StartedChild = {
  readonly child: ChildProcess;
  readonly exited: Promise<ChildExit>;
  readonly statuses: ChildStatus[];
};

type PersistedUpdate = {
  readonly ok: true;
  readonly id: string;
};

type RestartEffectCount = {
  readonly count: number;
};

type QueueRow = {
  readonly state: string;
  readonly attempts: number;
};

const FIXTURE_UPDATE = {
  update_id: FIXTURE_UPDATE_ID,
  message: {
    message_id: 902,
    date: 1,
    chat: { id: -903, type: 'group', title: 'fixture' },
    from: { id: 904, is_bot: false, first_name: 'fixture' },
  },
} as const;

class RestartHarnessError extends Error {
  readonly name = 'RestartHarnessError';

  constructor(code: string) {
    super(code);
  }
}

test(
  'replays a durable grammY update after a SIGKILL without duplicating its domain effect',
  { skip: !DATABASE_CONFIGURED },
  async () => {
    await rm(EVIDENCE_PATH, { force: true });
    const migrations = await discoverMigrationFiles(join(REPOSITORY_ROOT, 'packages/db/migrations'));

    await withMigratedTelegramDb(migrations, async (client, databaseUrl) => {
      await client.query(
        `create table telegram_restart_domain_effects (
           source_fingerprint text primary key,
           applied_at timestamptz not null default clock_timestamp()
         )`,
      );
      const persisted = await telegramRpc<PersistedUpdate>(
        client,
        'telegram_persist_update($1,$2,$3,$4,$5::jsonb,$6)',
        [
          FIXTURE_SOURCE_KEY,
          FIXTURE_FINGERPRINT,
          FIXTURE_UPDATE_ID,
          'message',
          JSON.stringify(FIXTURE_UPDATE),
          'pending_engine',
        ],
      );
      let childA: StartedChild | undefined;
      let childB: StartedChild | undefined;

      try {
        childA = startChild('crash', databaseUrl);
        await waitForStatus(childA, 'effect_committed');
        assert.equal(childA.child.kill('SIGKILL'), true);
        const crashExit = await childA.exited;
        childA = undefined;
        assert.equal(crashExit.signal, 'SIGKILL');

        await client.query(
          "update telegram_updates set lease_expires_at = clock_timestamp() - interval '1 millisecond' where id = $1",
          [persisted.id],
        );

        childB = startChild('replay', databaseUrl);
        await waitForStatus(childB, 'completed');
        const replayExit = await childB.exited;
        childB = undefined;
        assert.equal(replayExit.code, 0);
        assert.equal(replayExit.signal, null);
        await assertRestartOutcome(client);
      } finally {
        await terminateChild(childA);
        await terminateChild(childB);
      }
    });

    await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
    await writeFile(EVIDENCE_PATH, 'TASK_9_TELEGRAM_RESTART_PASS\n', 'utf8');
  },
);

function startChild(mode: ChildMode, databaseUrl: string): StartedChild {
  const child = fork(CHILD_PATH, [mode], {
    cwd: REPOSITORY_ROOT,
    env: {
      DATABASE_URL: databaseUrl,
      PATH: process.env.PATH ?? '',
      USER: process.env.USER,
      HOME: process.env.HOME,
      PGUSER: process.env.PGUSER,
      PGPASSWORD: process.env.PGPASSWORD,
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGDATABASE: process.env.PGDATABASE,
      PGSSLMODE: process.env.PGSSLMODE,
      PGSSLROOTCERT: process.env.PGSSLROOTCERT,
      PGSSLCERT: process.env.PGSSLCERT,
      PGSSLKEY: process.env.PGSSLKEY,
    },
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const statuses: ChildStatus[] = [];
  child.on('message', (message: unknown) => {
    const status = childStatus(message);
    if (status !== undefined) statuses.push(status);
  });
  return { child, statuses, exited: observeExit(child) };
}

function observeExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new RestartHarnessError('child_process_failed')));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForStatus(started: StartedChild, expected: 'effect_committed' | 'completed'): Promise<void> {
  const priorFailure = started.statuses.find(isFailureStatus);
  if (priorFailure !== undefined) throw new RestartHarnessError(priorFailure);
  if (started.statuses.includes(expected)) return;
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      started.child.off('message', onMessage);
      started.child.off('exit', onExit);
    };
    const fail = (code: string): void => {
      cleanup();
      reject(new RestartHarnessError(code));
    };
    const onMessage = (message: unknown): void => {
      const status = childStatus(message);
      if (status === expected) {
        cleanup();
        resolve();
      } else if (status !== undefined && isFailureStatus(status)) {
        fail(status);
      }
    };
    const onExit = (): void => fail('child_exited_before_status');
    timer = setTimeout(() => fail('child_status_timeout'), CHILD_TIMEOUT_MS);
    started.child.on('message', onMessage);
    started.child.once('exit', onExit);
  });
}

function childStatus(value: unknown): ChildStatus | undefined {
  switch (value) {
    case 'effect_committed':
    case 'completed':
    case 'failed_mode':
    case 'failed_database':
    case 'failed_connection':
    case 'failed_lease':
    case 'failed_leased':
    case 'failed_effect':
      return value;
    default:
      return undefined;
  }
}

function isFailureStatus(status: ChildStatus): status is Exclude<ChildStatus, 'effect_committed' | 'completed'> {
  return status.startsWith('failed_');
}

async function terminateChild(started: StartedChild | undefined): Promise<void> {
  if (started === undefined) return;
  if (started.child.exitCode === null && started.child.signalCode === null) started.child.kill('SIGKILL');
  await started.exited.then(
    () => undefined,
    () => undefined,
  );
}

async function assertRestartOutcome(client: import('pg').Client): Promise<void> {
  const effects = await client.query<RestartEffectCount>(
    'select count(*)::integer as count from telegram_restart_domain_effects',
  );
  assert.equal(effects.rows[0]?.count, 1);

  const queue = await client.query<QueueRow>('select state, attempts from telegram_updates');
  if (queue.rows.length !== 1) throw new RestartHarnessError('unexpected_queue_row_count');
  const row = queue.rows[0];
  if (row === undefined) throw new RestartHarnessError('missing_queue_row');
  assert.equal(row.state, 'completed');
  assert.equal(row.attempts, 2);
}
