import {
  CHECKLIST_NAMES,
  DISABLED_FIRST_FLAG_NAMES,
  EXTERNAL_CREDENTIALS_REQUIRED,
  RESOURCE_NAMES,
  STAGING_PROMOTION_SCHEMA_VERSION,
  type BuildAttestation,
  type DeploymentConfig,
  type DisabledFirstFlags,
  type PromotionChecklist,
  type PromotionInput,
  type ResourceSet,
} from './schema.js';

const REDACTED_RESOURCE = /^redacted:[a-z0-9][a-z0-9._-]{2,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

export class PromotionContractError extends Error {
  readonly name = 'PromotionContractError';

  constructor(readonly issues: readonly string[]) {
    super(`Staging promotion contract rejected: ${issues.join('; ')}`);
  }
}

export function parsePromotionInput(value: unknown): PromotionInput {
  const input = requireRecord(value, '$');
  requireExactKeys(input, '$', [
    'schema_version',
    'resources',
    'deployments',
    'checklist',
    'builds',
    'external_operations',
  ]);
  const schemaVersion = requireNumber(input['schema_version'], '$.schema_version');
  if (schemaVersion !== STAGING_PROMOTION_SCHEMA_VERSION) throw issue('$.schema_version must equal 1');
  return {
    schema_version: STAGING_PROMOTION_SCHEMA_VERSION,
    resources: parseEnvironments(input['resources'], '$.resources', parseResourceSet),
    deployments: parseEnvironments(input['deployments'], '$.deployments', parseDeployment),
    checklist: parseChecklist(input['checklist']),
    builds: parseBuilds(input['builds']),
    external_operations: parseExternalOperations(input['external_operations']),
  };
}

function parseEnvironments<T>(
  value: unknown,
  path: string,
  parse: (candidate: unknown, candidatePath: string) => T,
): { readonly staging: T; readonly production: T } {
  const environments = requireRecord(value, path);
  requireExactKeys(environments, path, ['staging', 'production']);
  return {
    staging: parse(environments['staging'], `${path}.staging`),
    production: parse(environments['production'], `${path}.production`),
  };
}

function parseResourceSet(value: unknown, path: string): ResourceSet {
  const resources = requireRecord(value, path);
  requireExactKeys(resources, path, RESOURCE_NAMES);
  return {
    supabase_project: requireRedactedResource(resources['supabase_project'], `${path}.supabase_project`),
    engine_service: requireRedactedResource(resources['engine_service'], `${path}.engine_service`),
    concierge_service: requireRedactedResource(resources['concierge_service'], `${path}.concierge_service`),
    web_project: requireRedactedResource(resources['web_project'], `${path}.web_project`),
    telegram_bot: requireRedactedResource(resources['telegram_bot'], `${path}.telegram_bot`),
    route_token_set: requireRedactedResource(resources['route_token_set'], `${path}.route_token_set`),
    session_key_set: requireRedactedResource(resources['session_key_set'], `${path}.session_key_set`),
    analytics_key_set: requireRedactedResource(resources['analytics_key_set'], `${path}.analytics_key_set`),
    devnet_treasury: requireRedactedResource(resources['devnet_treasury'], `${path}.devnet_treasury`),
  };
}

function parseDeployment(value: unknown, path: string): DeploymentConfig {
  const deployment = requireRecord(value, path);
  requireExactKeys(deployment, path, [
    'engine_private_origin',
    'web_public_origin',
    'telegram_webhook_origin',
    'disabled_first',
  ]);
  return {
    engine_private_origin: requireString(deployment['engine_private_origin'], `${path}.engine_private_origin`),
    web_public_origin: requireString(deployment['web_public_origin'], `${path}.web_public_origin`),
    telegram_webhook_origin: requireString(deployment['telegram_webhook_origin'], `${path}.telegram_webhook_origin`),
    disabled_first: parseDisabledFirst(deployment['disabled_first'], `${path}.disabled_first`),
  };
}

function parseDisabledFirst(value: unknown, path: string): DisabledFirstFlags {
  const flags = requireRecord(value, path);
  requireExactKeys(flags, path, DISABLED_FIRST_FLAG_NAMES);
  return {
    WAGER_MODE_ENABLED: requireFalse(flags['WAGER_MODE_ENABLED'], `${path}.WAGER_MODE_ENABLED`),
    STARTER_GRANTS_ENABLED: requireFalse(flags['STARTER_GRANTS_ENABLED'], `${path}.STARTER_GRANTS_ENABLED`),
    WALLET_MINIAPP_ENABLED: requireFalse(flags['WALLET_MINIAPP_ENABLED'], `${path}.WALLET_MINIAPP_ENABLED`),
    STAKE_ACCEPTANCE_ENABLED: requireFalse(flags['STAKE_ACCEPTANCE_ENABLED'], `${path}.STAKE_ACCEPTANCE_ENABLED`),
    TREASURY_COVERAGE_ENFORCED: requireFalse(
      flags['TREASURY_COVERAGE_ENFORCED'],
      `${path}.TREASURY_COVERAGE_ENFORCED`,
    ),
  };
}

function parseChecklist(value: unknown): PromotionChecklist {
  const checklist = requireRecord(value, '$.checklist');
  requireExactKeys(checklist, '$.checklist', CHECKLIST_NAMES);
  return {
    staging_isolated: requireTrue(checklist['staging_isolated'], '$.checklist.staging_isolated'),
    resource_ids_redacted: requireTrue(checklist['resource_ids_redacted'], '$.checklist.resource_ids_redacted'),
    fresh_migrations_verified: requireTrue(checklist['fresh_migrations_verified'], '$.checklist.fresh_migrations_verified'),
    upgrade_migrations_verified: requireTrue(checklist['upgrade_migrations_verified'], '$.checklist.upgrade_migrations_verified'),
    private_engine_route_verified: requireTrue(
      checklist['private_engine_route_verified'],
      '$.checklist.private_engine_route_verified',
    ),
    readiness_verified: requireTrue(checklist['readiness_verified'], '$.checklist.readiness_verified'),
  };
}

function parseBuilds(value: unknown): PromotionInput['builds'] {
  const builds = requireRecord(value, '$.builds');
  requireExactKeys(builds, '$.builds', ['engine', 'concierge', 'web']);
  return {
    engine: parseBuild(builds['engine'], '$.builds.engine'),
    concierge: parseBuild(builds['concierge'], '$.builds.concierge'),
    web: parseBuild(builds['web'], '$.builds.web'),
  };
}

function parseBuild(value: unknown, path: string): BuildAttestation {
  const build = requireRecord(value, path);
  requireExactKeys(build, path, ['source_commit', 'artifact_sha256']);
  const sourceCommit = requireString(build['source_commit'], `${path}.source_commit`);
  const artifactHash = requireString(build['artifact_sha256'], `${path}.artifact_sha256`);
  if (!COMMIT.test(sourceCommit)) throw issue(`${path}.source_commit must be a commit hash`);
  if (!SHA256.test(artifactHash)) throw issue(`${path}.artifact_sha256 must be sha256`);
  return { source_commit: sourceCommit, artifact_sha256: artifactHash };
}

function parseExternalOperations(value: unknown): PromotionInput['external_operations'] {
  const operations = requireRecord(value, '$.external_operations');
  requireExactKeys(operations, '$.external_operations', ['resource_provisioning', 'webhook_deployment']);
  return {
    resource_provisioning: requireExternalOnly(
      operations['resource_provisioning'],
      '$.external_operations.resource_provisioning',
    ),
    webhook_deployment: requireExternalOnly(
      operations['webhook_deployment'],
      '$.external_operations.webhook_deployment',
    ),
  };
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw issue(`${path} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: Readonly<Record<string, unknown>>, path: string, keys: readonly string[]): void {
  const missing = keys.filter((key) => value[key] === undefined);
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw issue(`${path} must contain exactly [${keys.join(', ')}]`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw issue(`${path} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw issue(`${path} must be an integer`);
  return value;
}

function requireRedactedResource(value: unknown, path: string): string {
  const identifier = requireString(value, path);
  if (!REDACTED_RESOURCE.test(identifier)) throw issue(`${path} must be a redacted resource ID`);
  return identifier;
}

function requireTrue(value: unknown, path: string): true {
  if (value !== true) throw issue(`${path} must be true`);
  return true;
}

function requireFalse(value: unknown, path: string): false {
  if (value !== false) throw issue(`${path} must remain false for disabled-first rollout`);
  return false;
}

function requireExternalOnly(value: unknown, path: string): typeof EXTERNAL_CREDENTIALS_REQUIRED {
  if (value !== EXTERNAL_CREDENTIALS_REQUIRED) throw issue(`${path} must remain external_credentials_required`);
  return EXTERNAL_CREDENTIALS_REQUIRED;
}

function issue(message: string): PromotionContractError {
  return new PromotionContractError([message]);
}
