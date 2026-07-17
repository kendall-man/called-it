import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  PromotionContractError,
  createPromotionManifest,
  type SourceEvidence,
} from './contract.js';
import { SourceEvidenceError, collectSourceEvidence } from './source-evidence.js';

const execFileAsync = promisify(execFile);
const SHA256 = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

test('creates a credential-free manifest for isolated disabled-first staging', async (context) => {
  // Given tracked release inputs and distinct redacted resource IDs
  const root = await createGitFixture(context);
  const source = await collectSourceEvidence(root);

  // When a complete preflight input is assembled for that source
  const manifest = createPromotionManifest(promotionInput(source), source);

  // Then the manifest captures source hashes without any credential values
  assert.equal(manifest.source.source_commit, source.source_commit);
  assert.equal(manifest.source.pnpm_lock_sha256.length, 64);
  assert.deepEqual(manifest.deployments.staging.disabled_first, disabledFirst());
  assert.equal(manifest.external_operations.webhook_deployment, 'external_credentials_required');
  assert.equal(manifest.source.migrations[0]?.path, 'packages/db/migrations/0001_init.sql');
});

test('rejects resource IDs that are not explicitly redacted', () => {
  // Given a config that carries a raw provider identifier
  const input = promotionInput(staticSource());
  input.resources.staging.supabase_project = 'actual-provider-project-reference';

  // When the preflight parser receives it
  // Then the raw identifier is refused before a manifest can be created
  assert.throws(
    () => createPromotionManifest(input, staticSource()),
    (error: unknown) => error instanceof PromotionContractError && /redacted resource ID/u.test(error.message),
  );
});

test('rejects shared staging and production resources', () => {
  // Given an otherwise valid config with one shared resource ID
  const input = promotionInput(staticSource());
  input.resources.production.telegram_bot = input.resources.staging.telegram_bot;

  // When preflight evaluates resource isolation
  // Then it fails closed rather than allowing a shared Telegram bot
  assert.throws(
    () => createPromotionManifest(input, staticSource()),
    (error: unknown) => error instanceof PromotionContractError && /must differ/u.test(error.message),
  );
});

test('rejects an enabled disabled-first flag', () => {
  // Given a deployment that enables stake acceptance before promotion
  const input = promotionInput(staticSource());
  input.deployments.production.disabled_first.STAKE_ACCEPTANCE_ENABLED = true;

  // When the parser receives the rollout state
  // Then it rejects the enabled flag at the boundary
  assert.throws(
    () => createPromotionManifest(input, staticSource()),
    (error: unknown) => error instanceof PromotionContractError && /must remain false/u.test(error.message),
  );
});

test('rejects public engine origins and non-HTTPS public endpoints', () => {
  // Given a deployment that routes the private engine publicly and exposes HTTP webhook traffic
  const input = promotionInput(staticSource());
  input.deployments.staging.engine_private_origin = 'https://engine.example.com';
  input.deployments.staging.telegram_webhook_origin = 'http://concierge.example.com';

  // When the origin constraints are evaluated
  // Then both private-routing and HTTPS failures are reported
  assert.throws(
    () => createPromotionManifest(input, staticSource()),
    (error: unknown) =>
      error instanceof PromotionContractError &&
      /Railway private host/u.test(error.message) &&
      /must use HTTPS/u.test(error.message),
  );
});

test('rejects build attestations from a different commit', () => {
  // Given a build hash that is attributed to a different commit
  const input = promotionInput(staticSource());
  input.builds.web.source_commit = 'c'.repeat(40);

  // When the manifest is built
  // Then it cannot bind the deployed web build to this release source
  assert.throws(
    () => createPromotionManifest(input, staticSource()),
    (error: unknown) => error instanceof PromotionContractError && /builds.web.source_commit/u.test(error.message),
  );
});

test('refuses a claimed webhook deployment because it requires external credentials', () => {
  // Given a config that claims a webhook change completed inside this contract
  const input = promotionInput(staticSource());
  input.external_operations.webhook_deployment = 'completed';

  // When the preflight parser receives the status
  // Then it refuses to turn a source-controlled check into deployment evidence
  assert.throws(
    () => createPromotionManifest(input, staticSource()),
    (error: unknown) => error instanceof PromotionContractError && /external_credentials_required/u.test(error.message),
  );
});

test('refuses migration checksums while a migration is untracked', async (context) => {
  // Given a repository with one tracked migration and one new migration file
  const root = await createGitFixture(context);
  await writeFile(join(root, 'packages/db/migrations/0002_new.sql'), 'select 2;\n', 'utf8');

  // When source evidence is collected
  // Then it refuses to make a partial migration checksum manifest
  await assert.rejects(collectSourceEvidence(root), SourceEvidenceError);
  await assert.rejects(collectSourceEvidence(root), /all migration files must be tracked/u);
});

function promotionInput(source: SourceEvidence) {
  return {
    schema_version: 1,
    resources: {
      staging: resourceSet('staging'),
      production: resourceSet('production'),
    },
    deployments: {
      staging: deployment('staging'),
      production: deployment('production'),
    },
    checklist: {
      staging_isolated: true,
      resource_ids_redacted: true,
      fresh_migrations_verified: true,
      upgrade_migrations_verified: true,
      private_engine_route_verified: true,
      readiness_verified: true,
    },
    builds: {
      engine: { source_commit: source.source_commit, artifact_sha256: SHA256 },
      concierge: { source_commit: source.source_commit, artifact_sha256: SHA256.replace('a', 'b') },
      web: { source_commit: source.source_commit, artifact_sha256: SHA256.replace('a', 'c') },
    },
    external_operations: {
      resource_provisioning: 'external_credentials_required',
      webhook_deployment: 'external_credentials_required',
    },
  };
}

function resourceSet(environment: string) {
  return {
    supabase_project: `redacted:${environment}-supabase`,
    engine_service: `redacted:${environment}-engine`,
    concierge_service: `redacted:${environment}-concierge`,
    web_project: `redacted:${environment}-web`,
    telegram_bot: `redacted:${environment}-telegram`,
    route_token_set: `redacted:${environment}-route-tokens`,
    session_key_set: `redacted:${environment}-session-keys`,
    analytics_key_set: `redacted:${environment}-analytics`,
    devnet_treasury: `redacted:${environment}-treasury`,
  };
}

function deployment(environment: string) {
  return {
    engine_private_origin: `http://engine-${environment}.railway.internal:8790`,
    web_public_origin: `https://${environment}.calledit.example`,
    telegram_webhook_origin: `https://${environment}-concierge.calledit.example`,
    disabled_first: disabledFirst(),
  };
}

function disabledFirst() {
  return {
    WAGER_MODE_ENABLED: false,
    STARTER_GRANTS_ENABLED: false,
    WALLET_MINIAPP_ENABLED: false,
    STAKE_ACCEPTANCE_ENABLED: false,
    TREASURY_COVERAGE_ENFORCED: false,
  };
}

function staticSource(): SourceEvidence {
  return {
    source_commit: COMMIT,
    pnpm_lock_sha256: SHA256,
    migrations: [{ path: 'packages/db/migrations/0001_init.sql', sha256: SHA256 }],
  };
}

async function createGitFixture(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'calledit-staging-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages/db/migrations'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8'),
    writeFile(join(root, 'packages/db/migrations/0001_init.sql'), 'select 1;\n', 'utf8'),
  ]);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'staging-test@example.invalid']);
  await git(root, ['config', 'user.name', 'Staging Test']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'fixture']);
  return root;
}

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-C', root, ...args]);
}
