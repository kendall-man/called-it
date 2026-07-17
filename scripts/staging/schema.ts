export const STAGING_PROMOTION_SCHEMA_VERSION = 1;

export const RESOURCE_NAMES = [
  'supabase_project',
  'engine_service',
  'concierge_service',
  'web_project',
  'telegram_bot',
  'route_token_set',
  'session_key_set',
  'analytics_key_set',
  'devnet_treasury',
] as const;

export const DISABLED_FIRST_FLAG_NAMES = [
  'WAGER_MODE_ENABLED',
  'STARTER_GRANTS_ENABLED',
  'WALLET_MINIAPP_ENABLED',
  'STAKE_ACCEPTANCE_ENABLED',
  'TREASURY_COVERAGE_ENFORCED',
] as const;

export const CHECKLIST_NAMES = [
  'staging_isolated',
  'resource_ids_redacted',
  'fresh_migrations_verified',
  'upgrade_migrations_verified',
  'private_engine_route_verified',
  'readiness_verified',
] as const;

export const EXTERNAL_CREDENTIALS_REQUIRED = 'external_credentials_required' as const;

export type ResourceName = (typeof RESOURCE_NAMES)[number];
export type DisabledFirstFlagName = (typeof DISABLED_FIRST_FLAG_NAMES)[number];
export type ChecklistName = (typeof CHECKLIST_NAMES)[number];
export type ReleaseComponent = 'engine' | 'concierge' | 'web';

export type JsonSchema = {
  readonly $schema?: string;
  readonly type?: string | readonly string[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly additionalProperties?: boolean;
  readonly const?: string | number | boolean;
  readonly pattern?: string;
  readonly minItems?: number;
};

export type ResourceSet = {
  readonly supabase_project: string;
  readonly engine_service: string;
  readonly concierge_service: string;
  readonly web_project: string;
  readonly telegram_bot: string;
  readonly route_token_set: string;
  readonly session_key_set: string;
  readonly analytics_key_set: string;
  readonly devnet_treasury: string;
};

export type DisabledFirstFlags = {
  readonly WAGER_MODE_ENABLED: false;
  readonly STARTER_GRANTS_ENABLED: false;
  readonly WALLET_MINIAPP_ENABLED: false;
  readonly STAKE_ACCEPTANCE_ENABLED: false;
  readonly TREASURY_COVERAGE_ENFORCED: false;
};

export type DeploymentConfig = {
  readonly engine_private_origin: string;
  readonly web_public_origin: string;
  readonly telegram_webhook_origin: string;
  readonly disabled_first: DisabledFirstFlags;
};

export type PromotionChecklist = {
  readonly staging_isolated: true;
  readonly resource_ids_redacted: true;
  readonly fresh_migrations_verified: true;
  readonly upgrade_migrations_verified: true;
  readonly private_engine_route_verified: true;
  readonly readiness_verified: true;
};

export type BuildAttestation = {
  readonly source_commit: string;
  readonly artifact_sha256: string;
};

export type PromotionInput = {
  readonly schema_version: typeof STAGING_PROMOTION_SCHEMA_VERSION;
  readonly resources: { readonly staging: ResourceSet; readonly production: ResourceSet };
  readonly deployments: { readonly staging: DeploymentConfig; readonly production: DeploymentConfig };
  readonly checklist: PromotionChecklist;
  readonly builds: {
    readonly engine: BuildAttestation;
    readonly concierge: BuildAttestation;
    readonly web: BuildAttestation;
  };
  readonly external_operations: {
    readonly resource_provisioning: typeof EXTERNAL_CREDENTIALS_REQUIRED;
    readonly webhook_deployment: typeof EXTERNAL_CREDENTIALS_REQUIRED;
  };
};

export type MigrationChecksum = {
  readonly path: string;
  readonly sha256: string;
};

export type SourceEvidence = {
  readonly source_commit: string;
  readonly pnpm_lock_sha256: string;
  readonly migrations: readonly MigrationChecksum[];
};

export type PromotionManifest = {
  readonly schema_version: typeof STAGING_PROMOTION_SCHEMA_VERSION;
  readonly source: SourceEvidence;
  readonly resources: PromotionInput['resources'];
  readonly deployments: PromotionInput['deployments'];
  readonly checklist: PromotionChecklist;
  readonly builds: PromotionInput['builds'];
  readonly external_operations: PromotionInput['external_operations'];
};

const REDACTED_RESOURCE_PATTERN = '^redacted:[a-z0-9][a-z0-9._-]{2,127}$';
const SHA256_PATTERN = '^[a-f0-9]{64}$';
const COMMIT_PATTERN = '^[a-f0-9]{40}$';

const disabledFirstSchema = {
  type: 'object',
  additionalProperties: false,
  required: DISABLED_FIRST_FLAG_NAMES,
  properties: Object.fromEntries(DISABLED_FIRST_FLAG_NAMES.map((name) => [name, { const: false }])),
} satisfies JsonSchema;

const resourceSetSchema = {
  type: 'object',
  additionalProperties: false,
  required: RESOURCE_NAMES,
  properties: Object.fromEntries(
    RESOURCE_NAMES.map((name) => [name, { type: 'string', pattern: REDACTED_RESOURCE_PATTERN }]),
  ),
} satisfies JsonSchema;

const deploymentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['engine_private_origin', 'web_public_origin', 'telegram_webhook_origin', 'disabled_first'],
  properties: {
    engine_private_origin: { type: 'string' },
    web_public_origin: { type: 'string' },
    telegram_webhook_origin: { type: 'string' },
    disabled_first: disabledFirstSchema,
  },
} satisfies JsonSchema;

const buildSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source_commit', 'artifact_sha256'],
  properties: {
    source_commit: { type: 'string', pattern: COMMIT_PATTERN },
    artifact_sha256: { type: 'string', pattern: SHA256_PATTERN },
  },
} satisfies JsonSchema;

export const STAGING_PROMOTION_INPUT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'resources', 'deployments', 'checklist', 'builds', 'external_operations'],
  properties: {
    schema_version: { const: STAGING_PROMOTION_SCHEMA_VERSION },
    resources: {
      type: 'object',
      additionalProperties: false,
      required: ['staging', 'production'],
      properties: { staging: resourceSetSchema, production: resourceSetSchema },
    },
    deployments: {
      type: 'object',
      additionalProperties: false,
      required: ['staging', 'production'],
      properties: { staging: deploymentSchema, production: deploymentSchema },
    },
    checklist: {
      type: 'object',
      additionalProperties: false,
      required: CHECKLIST_NAMES,
      properties: Object.fromEntries(CHECKLIST_NAMES.map((name) => [name, { const: true }])),
    },
    builds: {
      type: 'object',
      additionalProperties: false,
      required: ['engine', 'concierge', 'web'],
      properties: { engine: buildSchema, concierge: buildSchema, web: buildSchema },
    },
    external_operations: {
      type: 'object',
      additionalProperties: false,
      required: ['resource_provisioning', 'webhook_deployment'],
      properties: {
        resource_provisioning: { const: EXTERNAL_CREDENTIALS_REQUIRED },
        webhook_deployment: { const: EXTERNAL_CREDENTIALS_REQUIRED },
      },
    },
  },
} satisfies JsonSchema;
