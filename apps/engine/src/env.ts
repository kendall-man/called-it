import { z } from 'zod';

const MillisecondsSchema = z.coerce.number().int().positive().max(86_400_000);
const Base64KeySchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/).refine(
  (value) => Buffer.from(value, 'base64').toString('base64') === value,
);

/**
 * Environment contract — exactly the names declared in the repo-root
 * `.env.example`. The engine refuses to boot on an invalid environment so a
 * misconfigured deploy fails loudly instead of half-working.
 */
const EnvSchema = z.object({
  DEPLOYMENT_ENV: z.enum(['development', 'staging', 'production']),
  TELEGRAM_BOT_TOKEN: z.string().min(10, 'BotFather token required'),
  TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{3,30}[Bb][Oo][Tt]$/),
  TELEGRAM_WEBHOOK_SECRET_TOKEN: z.string().min(32).optional(),
  GLM_API_KEY: z.string().min(1, 'GLM (Z.ai) key required for the agent'),
  GLM_BASE_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TXLINE_API_BASE: z.string().url(),
  TXLINE_GUEST_JWT: z.string().min(1),
  TXLINE_API_TOKEN: z.string().min(1),
  SOLANA_RPC_URL: z.string().url().optional(),
  /** Optional: without it the proof worker degrades to "unavailable" badges. */
  SOLANA_KEYPAIR_B58: z.string().optional(),
  TXORACLE_PROGRAM_ID: z.string().min(32),
  TXL_MINT: z.string().min(32),
  WEB_BASE_URL: z.string().url(),
  WALLET_LINK_DOMAIN: z.string().regex(/^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/),
  ANALYTICS_HMAC_SECRET: Base64KeySchema,
  ENGINE_CONCIERGE_TOKEN: z.string().min(32),
  ENGINE_TELEGRAM_TOKEN: z.string().min(32),
  ENGINE_OPS_TOKEN: z.string().min(32),
  /**
   * Optional: bearer token for the engine's HTTP API (the concierge agent's
   * integration surface). Absent → the API never starts listening.
   */
  ENGINE_API_TOKEN: z.string().min(24, 'use a long random token').optional(),
  /** HTTP port for the engine API (Railway injects PORT). */
  PORT: z.coerce.number().int().positive().default(8790),
  /**
   * How Telegram updates reach this process. 'poll' long-polls getUpdates
   * (default, standalone). 'webhook' means the concierge owns the bot's
   * webhook and forwards non-conversational updates to POST
   * /api/telegram-update — the engine must NOT poll (setWebhook makes
   * getUpdates return 409) and requires ENGINE_API_TOKEN.
   */
  TELEGRAM_INGRESS: z.enum(['poll', 'webhook']).default('poll'),
  /** Wager-mode master switch — anything but the literal 'true' means OFF. */
  WAGER_MODE_ENABLED: z.enum(['true', 'false']).default('false'),
  /**
   * Dedicated plain-SOL treasury for wager mode. NEVER the TxL-holding
   * SOLANA_KEYPAIR_B58 (sponsor terms: TxL is never wagering collateral).
   * Absent → the wager module degrades to null exactly like the flag being off.
   */
  WAGER_TREASURY_KEYPAIR_B58: z.string().optional(),
  /** Optional ops chat for wager solvency alerts. */
  WAGER_OPS_CHAT_ID: z.string().optional(),
  STARTER_GRANTS_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true'),
  WALLET_MINIAPP_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true'),
  STAKE_ACCEPTANCE_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true'),
  TREASURY_COVERAGE_ENFORCED: z.enum(['true', 'false']).transform((value) => value === 'true'),
  QUEUE_LEASE_MS: MillisecondsSchema,
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100),
  QUEUE_RETRY_BASE_MS: MillisecondsSchema,
  QUEUE_RETRY_MAX_MS: MillisecondsSchema,
  READINESS_CHECK_TIMEOUT_MS: MillisecondsSchema.max(10_000),
  READINESS_FEED_MAX_AGE_MS: MillisecondsSchema,
  READINESS_WORKER_MAX_AGE_MS: MillisecondsSchema,
  READINESS_INGRESS_MAX_AGE_MS: MillisecondsSchema,
  READINESS_PROOF_MAX_BACKLOG: z.coerce.number().int().min(0).max(1_000_000),
  READINESS_PROOF_MAX_OLDEST_AGE_MS: MillisecondsSchema,
  READINESS_SETTLEMENT_MAX_BACKLOG: z.coerce.number().int().min(0).max(1_000_000),
  READINESS_SETTLEMENT_MAX_OLDEST_AGE_MS: MillisecondsSchema,
  SHUTDOWN_DRAIN_TIMEOUT_MS: MillisecondsSchema.max(15_000),
}).superRefine((env, ctx) => {
  const addPairIssue = (left: string, right: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [left], message: 'invalid relationship' });
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [right], message: 'invalid relationship' });
  };
  const deployed = env.DEPLOYMENT_ENV !== 'development';
  if (deployed && env.GLM_BASE_URL === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GLM_BASE_URL'],
      message: 'required in deployed environments',
    });
  }
  if (deployed && env.SOLANA_RPC_URL === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SOLANA_RPC_URL'],
      message: 'required in deployed environments',
    });
  }
  if (deployed && env.TELEGRAM_INGRESS !== 'webhook') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TELEGRAM_INGRESS'],
      message: 'deployed environments require webhook ingress',
    });
  }
  if ((deployed || env.TELEGRAM_INGRESS === 'webhook') && env.TELEGRAM_WEBHOOK_SECRET_TOKEN === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TELEGRAM_WEBHOOK_SECRET_TOKEN'],
      message: 'required for webhook ingress',
    });
  }
  if (deployed && new URL(env.WEB_BASE_URL).protocol !== 'https:') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WEB_BASE_URL'],
      message: 'deployed environments require HTTPS',
    });
  }
  if (new URL(env.WEB_BASE_URL).hostname !== env.WALLET_LINK_DOMAIN) {
    addPairIssue('WALLET_LINK_DOMAIN', 'WEB_BASE_URL');
  }
  if (env.QUEUE_RETRY_BASE_MS > env.QUEUE_RETRY_MAX_MS) {
    addPairIssue('QUEUE_RETRY_BASE_MS', 'QUEUE_RETRY_MAX_MS');
  }
  if (env.READINESS_CHECK_TIMEOUT_MS >= env.QUEUE_LEASE_MS) {
    addPairIssue('QUEUE_LEASE_MS', 'READINESS_CHECK_TIMEOUT_MS');
  }
  if (env.READINESS_CHECK_TIMEOUT_MS >= env.SHUTDOWN_DRAIN_TIMEOUT_MS) {
    addPairIssue('READINESS_CHECK_TIMEOUT_MS', 'SHUTDOWN_DRAIN_TIMEOUT_MS');
  }

  const routeTokenPairs = [
    ['ENGINE_CONCIERGE_TOKEN', env.ENGINE_CONCIERGE_TOKEN, 'ENGINE_TELEGRAM_TOKEN', env.ENGINE_TELEGRAM_TOKEN],
    ['ENGINE_CONCIERGE_TOKEN', env.ENGINE_CONCIERGE_TOKEN, 'ENGINE_OPS_TOKEN', env.ENGINE_OPS_TOKEN],
    ['ENGINE_TELEGRAM_TOKEN', env.ENGINE_TELEGRAM_TOKEN, 'ENGINE_OPS_TOKEN', env.ENGINE_OPS_TOKEN],
  ] as const;
  for (const [leftName, leftToken, rightName, rightToken] of routeTokenPairs) {
    if (leftToken === rightToken) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [leftName], message: 'must be unique' });
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [rightName], message: 'must be unique' });
    }
  }

  if (env.STARTER_GRANTS_ENABLED && !env.STAKE_ACCEPTANCE_ENABLED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STARTER_GRANTS_ENABLED'],
      message: 'requires stake acceptance',
    });
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STAKE_ACCEPTANCE_ENABLED'],
      message: 'required by starter grants',
    });
  }

  if (env.STAKE_ACCEPTANCE_ENABLED) {
    if (env.WAGER_MODE_ENABLED === 'false') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STAKE_ACCEPTANCE_ENABLED'],
        message: 'requires wager mode',
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WAGER_MODE_ENABLED'],
        message: 'required by stake acceptance',
      });
    }
    if (env.WAGER_TREASURY_KEYPAIR_B58 === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WAGER_TREASURY_KEYPAIR_B58'],
        message: 'required for stake acceptance',
      });
    }
    if (!env.TREASURY_COVERAGE_ENFORCED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TREASURY_COVERAGE_ENFORCED'],
        message: 'required for stake acceptance',
      });
    }
  }

  // Sponsor terms: TxL is never wagering collateral. The wager treasury must
  // be its own plain-SOL keypair — refuse to boot on reuse of the TxL wallet.
  if (
    env.WAGER_TREASURY_KEYPAIR_B58 !== undefined &&
    env.WAGER_TREASURY_KEYPAIR_B58 === env.SOLANA_KEYPAIR_B58
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WAGER_TREASURY_KEYPAIR_B58'],
      message: 'must be a dedicated keypair — reusing SOLANA_KEYPAIR_B58 (the TxL wallet) is forbidden',
    });
  }

}).transform((env) => ({
  ...env,
  GLM_BASE_URL: env.GLM_BASE_URL ?? 'https://api.z.ai/api/anthropic',
  SOLANA_RPC_URL: env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
}));

export type Env = z.infer<typeof EnvSchema>;

export class EngineEnvironmentError extends Error {
  readonly name = 'EngineEnvironmentError';

  constructor(readonly variables: readonly string[]) {
    super(`Engine environment invalid: ${variables.join(', ')}`);
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const variables = [...new Set(
      parsed.error.issues.map((issue) => String(issue.path[0] ?? '(root)')),
    )].sort();
    throw new EngineEnvironmentError(variables);
  }
  return parsed.data;
}
