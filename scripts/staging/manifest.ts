import {
  RESOURCE_NAMES,
  STAGING_PROMOTION_SCHEMA_VERSION,
  type DeploymentConfig,
  type PromotionInput,
  type PromotionManifest,
  type SourceEvidence,
} from './schema.js';
import { PromotionContractError, parsePromotionInput } from './input.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

export function createPromotionManifest(input: unknown, source: SourceEvidence): PromotionManifest {
  const parsed = parsePromotionInput(input);
  const issues = [
    ...validateResourceIsolation(parsed.resources),
    ...validateDeploymentOrigins(parsed.deployments),
    ...validateSourceEvidence(source),
    ...validateBuildSources(parsed.builds, source.source_commit),
  ];
  if (issues.length > 0) throw new PromotionContractError(issues);
  return {
    schema_version: STAGING_PROMOTION_SCHEMA_VERSION,
    source: {
      source_commit: source.source_commit,
      pnpm_lock_sha256: source.pnpm_lock_sha256,
      migrations: source.migrations.map((migration) => ({ ...migration })),
    },
    resources: parsed.resources,
    deployments: parsed.deployments,
    checklist: parsed.checklist,
    builds: parsed.builds,
    external_operations: parsed.external_operations,
  };
}

function validateResourceIsolation(resources: PromotionInput['resources']): readonly string[] {
  const staging = Object.values(resources.staging);
  const production = Object.values(resources.production);
  const issues: string[] = [];
  for (const name of RESOURCE_NAMES) {
    if (resources.staging[name] === resources.production[name]) {
      issues.push(`resources.${name} must differ between staging and production`);
    }
  }
  for (const identifier of staging) {
    if (production.includes(identifier)) {
      issues.push('no staging resource ID may equal any production resource ID');
      break;
    }
  }
  return issues;
}

function validateDeploymentOrigins(deployments: PromotionInput['deployments']): readonly string[] {
  return [
    ...validateDeploymentOrigin(deployments.staging, 'deployments.staging'),
    ...validateDeploymentOrigin(deployments.production, 'deployments.production'),
  ];
}

function validateDeploymentOrigin(deployment: DeploymentConfig, path: string): readonly string[] {
  const issues: string[] = [];
  validateOrigin(deployment.engine_private_origin, `${path}.engine_private_origin`, issues, true);
  validateOrigin(deployment.web_public_origin, `${path}.web_public_origin`, issues, false);
  validateOrigin(deployment.telegram_webhook_origin, `${path}.telegram_webhook_origin`, issues, false);
  return issues;
}

function validateOrigin(value: string, path: string, issues: string[], privateEngine: boolean): void {
  if (!URL.canParse(value)) {
    issues.push(`${path} must be an absolute origin`);
    return;
  }
  const origin = new URL(value);
  if (origin.username !== '' || origin.password !== '' || origin.search !== '' || origin.hash !== '') {
    issues.push(`${path} must not include credentials, query, or fragment`);
  }
  if (origin.pathname !== '' && origin.pathname !== '/') issues.push(`${path} must not include a path`);
  if (privateEngine) {
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') issues.push(`${path} must use HTTP(S)`);
    if (!origin.hostname.endsWith('.railway.internal')) issues.push(`${path} must use a Railway private host`);
    return;
  }
  if (origin.protocol !== 'https:') issues.push(`${path} must use HTTPS`);
}

function validateSourceEvidence(source: SourceEvidence): readonly string[] {
  const issues: string[] = [];
  if (!COMMIT.test(source.source_commit)) issues.push('source.source_commit must be a commit hash');
  if (!SHA256.test(source.pnpm_lock_sha256)) issues.push('source.pnpm_lock_sha256 must be sha256');
  if (source.migrations.length === 0) issues.push('source.migrations must not be empty');
  const paths = new Set<string>();
  for (const migration of source.migrations) {
    if (!migration.path.startsWith('packages/db/migrations/') || !migration.path.endsWith('.sql')) {
      issues.push(`source migration path is not tracked migration-shaped: ${migration.path}`);
    }
    if (!SHA256.test(migration.sha256)) issues.push(`source migration checksum is not sha256: ${migration.path}`);
    if (paths.has(migration.path)) issues.push(`source migration appears more than once: ${migration.path}`);
    paths.add(migration.path);
  }
  return issues;
}

function validateBuildSources(builds: PromotionInput['builds'], sourceCommit: string): readonly string[] {
  const issues: string[] = [];
  for (const [name, build] of Object.entries(builds)) {
    if (build.source_commit !== sourceCommit) {
      issues.push(`builds.${name}.source_commit must match source.source_commit`);
    }
  }
  return issues;
}
