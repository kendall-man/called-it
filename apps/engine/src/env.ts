import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { compiledEscrowProgramIdForNetwork } from '@calledit/escrow-sdk';
import { z } from 'zod';
import { WAGER_RUNTIME_MODES, resolvedWagerRuntimeMode, validateWagerRuntimeEnvironment } from './wager-runtime-env.js';
import { expectedGenesisHash, rpcUrlLooksLikeDevnet, SOLANA_NETWORKS } from './solana-network.js';

export { WAGER_RUNTIME_MODES, type WagerRuntimeMode } from './wager-runtime-env.js';
export { SOLANA_NETWORKS, type SolanaNetwork } from './solana-network.js';

const MillisecondsSchema = z.coerce.number().int().positive().max(86_400_000);
const Sha256FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const OptionalConfiguredStringSchema = z.string().optional()
  .transform((value) => value?.trim() === '' ? undefined : value);
const OptionalBase58AddressSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/).optional(),
);
const OptionalUnsignedBigIntSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().regex(/^(?:0|[1-9]\d*)$/).transform(BigInt).optional(),
);
const Base64KeySchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/).refine(
  (value) => Buffer.from(value, 'base64').toString('base64') === value,
);
const BetaGroupAllowlistSchema = z.string().default('').transform((value, ctx) => {
  const text = value.trim();
  if (text === '') return [];
  const groupIds: number[] = [];
  const seen = new Set<number>();
  for (const rawGroupId of text.split(',')) {
    const candidate = rawGroupId.trim();
    if (!/^-\d+$/.test(candidate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain negative Telegram group ids' });
      return z.NEVER;
    }
    const groupId = Number(candidate);
    if (!Number.isSafeInteger(groupId) || groupId >= 0 || seen.has(groupId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain unique safe Telegram group ids' });
      return z.NEVER;
    }
    seen.add(groupId);
    groupIds.push(groupId);
  }
  return groupIds;
});
const EscrowOracleSignersSchema = z.string().default('').transform((value, ctx) => {
  const values = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (values.some((entry) => !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(entry))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain base58 public keys' });
    return z.NEVER;
  }
  return values;
});
const EscrowOracleSignerEndpointsSchema = z.string().default('').transform((value, ctx) => {
  if (value.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' });
    return z.NEVER;
  }
  const result = z.array(z.object({
    url: z.string().url(),
    bearerToken: z.string().min(1).optional(),
  }).strict()).length(3).safeParse(parsed);
  if (!result.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain exactly three signer endpoints' });
    return z.NEVER;
  }
  const origins = new Set<string>();
  for (const endpoint of result.data) {
    const url = new URL(endpoint.url);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || origins.has(url.origin)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must use three independent HTTPS origins' });
      return z.NEVER;
    }
    origins.add(url.origin);
  }
  return result.data;
});
const EscrowOracleLocalKeypairsSchema = z.string().default('').transform((value, ctx) => {
  if (value.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' });
    return z.NEVER;
  }
  const result = z.array(z.string().min(1)).length(3).safeParse(parsed);
  if (!result.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain exactly three keypairs' });
    return z.NEVER;
  }
  return result.data;
});
const EscrowMarketAuthorityEndpointSchema = z.string().default('').transform((value, ctx) => {
  if (value.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' });
    return z.NEVER;
  }
  const result = z.object({
    url: z.string().url(), bearerToken: z.string().min(1).optional(),
  }).strict().safeParse(parsed);
  if (!result.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain one signer endpoint' });
    return z.NEVER;
  }
  const url = new URL(result.data.url);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must use an authenticated HTTPS endpoint' });
    return z.NEVER;
  }
  return result.data;
});

function isPubliclyRoutableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (/(?:^|\.)(?:localhost|local|internal)$/.test(host)) return false;
  const version = isIP(host);
  if (version === 0) return true;
  if (version === 6) return !/^(?:::|f[cd]|fe[89ab]|ff)/.test(host);
  const [first = 0, second = 0, third = 0] = host.split('.').map(Number);
  return !(first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 168 || (second === 0 && (third === 0 || third === 2))))
    || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) || (first === 203 && second === 0 && third === 113));
}

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
  /**
   * Optional direct-link Mini App short name registered via BotFather /newapp
   * (gives t.me/<bot>/<short>). When set under escrow custody, offer cards use
   * in-group URL signing buttons; absent, behaviour is unchanged (callback
   * buttons + DM signing), which is the deployment safety switch.
   */
  TELEGRAM_MINIAPP_SHORT_NAME: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().regex(/^[A-Za-z0-9_]{3,64}$/).optional(),
  ),
  BETA_ALLOWED_GROUP_IDS: BetaGroupAllowlistSchema,
  /** Public beta removes Telegram group allowlists while retaining all per-market safety gates. */
  PUBLIC_BETA_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  GLM_API_KEY: z.string().min(1, 'GLM (Z.ai) key required for the agent'),
  GLM_BASE_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TXLINE_API_BASE: z.string().url(),
  TXLINE_GUEST_JWT: z.string().min(1),
  TXLINE_API_TOKEN: z.string().min(1),
  SOLANA_NETWORK: z.enum(SOLANA_NETWORKS).default('devnet'),
  SOLANA_RPC_URL: z.string().url().optional(),
  /** Optional: without it the proof worker degrades to "unavailable" badges. */
  SOLANA_KEYPAIR_B58: OptionalConfiguredStringSchema,
  TXORACLE_PROGRAM_ID: z.string().min(32),
  TXL_MINT: z.string().min(32),
  WEB_BASE_URL: z.string().url(),
  WALLET_LINK_DOMAIN: z.string().regex(/^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/),
  ANALYTICS_HMAC_SECRET: Base64KeySchema,
  ENGINE_CONCIERGE_TOKEN: z.string().min(32),
  ENGINE_TELEGRAM_TOKEN: z.string().min(32),
  ENGINE_OPS_TOKEN: z.string().min(32),
  WEB_CONCIERGE_TOKEN_SHA256: Sha256FingerprintSchema.optional(),
  /** HTTP port for the engine API (Railway injects PORT). */
  PORT: z.coerce.number().int().positive().default(8790),
  /** Completed-match replay multiplier; configurable so local signed journeys can avoid Telegram rate limits. */
  CALLEDIT_REPLAY_SPEED: z.coerce.number().int().min(1).max(1_000).default(20),
  /**
   * How Telegram updates reach this process. 'poll' long-polls getUpdates
   * (default, standalone). 'webhook' accepts Bot API updates directly at
   * /api/telegram-webhook and preserves the authenticated internal forwarding
   * route at /api/telegram-ingress. The engine must not poll in webhook mode.
   */
  TELEGRAM_INGRESS: z.enum(['poll', 'webhook']).default('poll'),
  /** Explicit wager capability boundary. Required for staging and production. */
  WAGER_RUNTIME_MODE: z.enum(WAGER_RUNTIME_MODES).optional(),
  /** Selects new-market financial routing. Legacy liabilities remain recoverable in both modes. */
  WAGER_CUSTODY_MODE: z.enum(['legacy', 'escrow']).default('legacy'),
  /** Legacy local input; deployed values must agree with the explicit runtime mode. */
  WAGER_MODE_ENABLED: z.enum(['true', 'false']).default('false'),
  /**
   * Dedicated plain-SOL treasury for wager mode. NEVER the TxL-holding
   * SOLANA_KEYPAIR_B58 (sponsor terms: TxL is never wagering collateral).
   * Required only by the funded runtime.
   */
  WAGER_TREASURY_KEYPAIR_B58: OptionalConfiguredStringSchema,
  /** Optional ops chat for wager solvency alerts. */
  WAGER_OPS_CHAT_ID: OptionalConfiguredStringSchema,
  ESCROW_ALLOWED_GROUP_IDS: BetaGroupAllowlistSchema,
  ESCROW_PROGRAM_ID: OptionalBase58AddressSchema,
  ESCROW_GENESIS_HASH: OptionalBase58AddressSchema,
  ESCROW_CANONICAL_USDC_MINT: OptionalBase58AddressSchema,
  ESCROW_CLASSIC_TOKEN_PROGRAM_ID: OptionalBase58AddressSchema,
  ESCROW_ORACLE_SET_PDA: OptionalBase58AddressSchema,
  ESCROW_ORACLE_SET_EPOCH: OptionalUnsignedBigIntSchema,
  ESCROW_ORACLE_THRESHOLD: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.coerce.number().int().min(1).max(8).optional(),
  ),
  ESCROW_ORACLE_SIGNERS: EscrowOracleSignersSchema,
  ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON: EscrowOracleSignerEndpointsSchema,
  ESCROW_ORACLE_LOCAL_KEYPAIRS_B58_JSON: EscrowOracleLocalKeypairsSchema,
  ESCROW_INDEXER_MAX_LAG_SLOTS: OptionalUnsignedBigIntSchema,
  /** Bound transaction-history reads so public RPC rate limits cannot starve cursor progress. */
  ESCROW_INDEXER_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /** Development-only: keep a Surfpool fork's finalized cursor in process. */
  ESCROW_LOCAL_FORK_INDEXER: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  ESCROW_WORKER_INTERVAL_MS: MillisecondsSchema.min(1_000).max(60_000).default(5_000),
  ESCROW_CONFIG_AUTHORITY: OptionalBase58AddressSchema,
  ESCROW_PAUSE_AUTHORITY: OptionalBase58AddressSchema,
  ESCROW_MARKET_CREATION_AUTHORITY: OptionalBase58AddressSchema,
  ESCROW_MARKET_AUTHORITY_KEYPAIR_B58: OptionalConfiguredStringSchema,
  ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON: EscrowMarketAuthorityEndpointSchema,
  ESCROW_UPGRADE_AUTHORITY: OptionalBase58AddressSchema,
  ESCROW_RESIDUAL_RECIPIENT: OptionalBase58AddressSchema,
  /** Fee payer only. It must never be accepted as a user position signer. */
  ESCROW_RELAYER_KEYPAIR_B58: OptionalConfiguredStringSchema,
  /** Bounded freeze authority. Must be distinct from relayer, config, and oracle signers. */
  ESCROW_FEED_OPERATOR_KEYPAIR_B58: OptionalConfiguredStringSchema,
  ESCROW_MAINNET_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
  STARTER_GRANTS_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true'),
  WALLET_MINIAPP_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true'),
  STAKE_ACCEPTANCE_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true'),
  /**
   * Two-step interactive stake ladder (side tap → value ladder → sign). OFF by
   * default and byte-for-byte the single-tap flow when unset: the offer card's
   * side buttons mint a stake/session on the first tap exactly as today. When
   * 'true' the side tap only edits the card to a value ladder and no assets move
   * until an explicit value pick (legacy) or Mini App signature (escrow). This
   * is the deploy safety switch for the whole lifecycle overhaul.
   */
  STAKE_LADDER_ENABLED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
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
  const addIssue = (variable: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [variable], message });
  };
  const deployed = env.DEPLOYMENT_ENV !== 'development';
  const wagerRuntimeMode = resolvedWagerRuntimeMode(env);
  validateWagerRuntimeEnvironment(env, { add: addIssue, addPair: addPairIssue });
  const betaActive = env.PUBLIC_BETA_ENABLED || deployed || env.BETA_ALLOWED_GROUP_IDS.length > 0;
  const webUrl = new URL(env.WEB_BASE_URL);
  if (env.ESCROW_LOCAL_FORK_INDEXER && deployed) {
    addIssue('ESCROW_LOCAL_FORK_INDEXER', 'is allowed only in development');
  }
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
  if (env.SOLANA_NETWORK === 'mainnet-beta') {
    if (env.DEPLOYMENT_ENV !== 'production') {
      addPairIssue('SOLANA_NETWORK', 'DEPLOYMENT_ENV');
    }
    if (env.SOLANA_RPC_URL === undefined || rpcUrlLooksLikeDevnet(env.SOLANA_RPC_URL)) {
      addIssue('SOLANA_RPC_URL', 'mainnet requires a non-devnet RPC URL');
    }
    if (wagerRuntimeMode !== 'funded') {
      addPairIssue('SOLANA_NETWORK', 'WAGER_RUNTIME_MODE');
    }
    if (env.STARTER_GRANTS_ENABLED) {
      addPairIssue('SOLANA_NETWORK', 'STARTER_GRANTS_ENABLED');
    }
    if (!env.STAKE_ACCEPTANCE_ENABLED) {
      addPairIssue('SOLANA_NETWORK', 'STAKE_ACCEPTANCE_ENABLED');
    }
    if (env.WAGER_CUSTODY_MODE === 'legacy' && !env.TREASURY_COVERAGE_ENFORCED) {
      addPairIssue('SOLANA_NETWORK', 'TREASURY_COVERAGE_ENFORCED');
    }
  }
  if (deployed && !env.PUBLIC_BETA_ENABLED && env.BETA_ALLOWED_GROUP_IDS.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BETA_ALLOWED_GROUP_IDS'],
      message: 'required in deployed beta environments',
    });
  }
  if (env.TELEGRAM_INGRESS === 'webhook' && env.TELEGRAM_WEBHOOK_SECRET_TOKEN === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TELEGRAM_WEBHOOK_SECRET_TOKEN'],
      message: 'required for webhook ingress',
    });
  }
  if (betaActive && (webUrl.protocol !== 'https:' || !isPubliclyRoutableHost(webUrl.hostname))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WEB_BASE_URL'],
      message: 'active beta requires a public HTTPS origin',
    });
  }
  if (webUrl.hostname !== env.WALLET_LINK_DOMAIN) {
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
  const routeTokens = [
    ['ENGINE_CONCIERGE_TOKEN', env.ENGINE_CONCIERGE_TOKEN],
    ['ENGINE_TELEGRAM_TOKEN', env.ENGINE_TELEGRAM_TOKEN],
    ['ENGINE_OPS_TOKEN', env.ENGINE_OPS_TOKEN],
  ] as const;
  const routeTokenPairs: ReadonlyArray<readonly [string, string, string, string]> = [
    [routeTokens[0][0], routeTokens[0][1], routeTokens[1][0], routeTokens[1][1]],
    [routeTokens[0][0], routeTokens[0][1], routeTokens[2][0], routeTokens[2][1]],
    [routeTokens[1][0], routeTokens[1][1], routeTokens[2][0], routeTokens[2][1]],
  ];
  for (const [leftName, leftToken, rightName, rightToken] of routeTokenPairs) {
    if (leftToken === rightToken) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [leftName], message: 'must be unique' });
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [rightName], message: 'must be unique' });
    }
  }
  for (const [name, token] of routeTokens) {
    if (env.WEB_CONCIERGE_TOKEN_SHA256 !== undefined && tokenFingerprint(token) === env.WEB_CONCIERGE_TOKEN_SHA256) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'must be unique' });
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['WEB_CONCIERGE_TOKEN'], message: 'must be unique' });
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

  if (
    env.STAKE_ACCEPTANCE_ENABLED &&
    wagerRuntimeMode === 'funded' &&
    env.WAGER_CUSTODY_MODE === 'legacy'
  ) {
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

  if (env.WAGER_CUSTODY_MODE === 'escrow') {
    const compiledProgramId = compiledEscrowProgramIdForNetwork(env.SOLANA_NETWORK);
    if (compiledProgramId === null) {
      addIssue('ESCROW_PROGRAM_ID', 'no compiled escrow program identity exists for this network');
      addIssue('WAGER_CUSTODY_MODE', 'escrow custody is unavailable for this network');
    } else if (
      env.ESCROW_PROGRAM_ID !== undefined &&
      env.ESCROW_PROGRAM_ID !== compiledProgramId
    ) {
      addPairIssue('ESCROW_PROGRAM_ID', 'SOLANA_NETWORK');
    }
    if (
      env.STAKE_ACCEPTANCE_ENABLED && !env.PUBLIC_BETA_ENABLED &&
      env.ESCROW_ALLOWED_GROUP_IDS.length === 0
    ) {
      addIssue('ESCROW_ALLOWED_GROUP_IDS', 'required when escrow intake is enabled');
    }
    const required = [
      ['ESCROW_PROGRAM_ID', env.ESCROW_PROGRAM_ID],
      ['ESCROW_GENESIS_HASH', env.ESCROW_GENESIS_HASH],
      ['ESCROW_CANONICAL_USDC_MINT', env.ESCROW_CANONICAL_USDC_MINT],
      ['ESCROW_CLASSIC_TOKEN_PROGRAM_ID', env.ESCROW_CLASSIC_TOKEN_PROGRAM_ID],
      ['ESCROW_ORACLE_SET_PDA', env.ESCROW_ORACLE_SET_PDA],
      ['ESCROW_ORACLE_SET_EPOCH', env.ESCROW_ORACLE_SET_EPOCH],
      ['ESCROW_ORACLE_THRESHOLD', env.ESCROW_ORACLE_THRESHOLD],
      ['ESCROW_INDEXER_MAX_LAG_SLOTS', env.ESCROW_INDEXER_MAX_LAG_SLOTS],
      ['ESCROW_CONFIG_AUTHORITY', env.ESCROW_CONFIG_AUTHORITY],
      ['ESCROW_PAUSE_AUTHORITY', env.ESCROW_PAUSE_AUTHORITY],
      ['ESCROW_MARKET_CREATION_AUTHORITY', env.ESCROW_MARKET_CREATION_AUTHORITY],
      ['ESCROW_UPGRADE_AUTHORITY', env.ESCROW_UPGRADE_AUTHORITY],
      ['ESCROW_RESIDUAL_RECIPIENT', env.ESCROW_RESIDUAL_RECIPIENT],
      ['ESCROW_RELAYER_KEYPAIR_B58', env.ESCROW_RELAYER_KEYPAIR_B58],
      ['ESCROW_FEED_OPERATOR_KEYPAIR_B58', env.ESCROW_FEED_OPERATOR_KEYPAIR_B58],
    ] as const;
    for (const [name, value] of required) {
      if (value === undefined) addIssue(name, 'required in escrow custody mode');
    }
    if (
      env.ESCROW_GENESIS_HASH !== undefined &&
      env.ESCROW_GENESIS_HASH !== expectedGenesisHash(env.SOLANA_NETWORK)
    ) addPairIssue('ESCROW_GENESIS_HASH', 'SOLANA_NETWORK');
    const uniqueSigners = new Set(env.ESCROW_ORACLE_SIGNERS);
    if (uniqueSigners.size !== env.ESCROW_ORACLE_SIGNERS.length) {
      addIssue('ESCROW_ORACLE_SIGNERS', 'must contain unique signers');
    }
    if (env.ESCROW_ORACLE_THRESHOLD !== 2 || uniqueSigners.size !== 3) {
      addPairIssue('ESCROW_ORACLE_SIGNERS', 'ESCROW_ORACLE_THRESHOLD');
    }
    const hasEndpoints = env.ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON.length > 0;
    const hasLocalKeys = env.ESCROW_ORACLE_LOCAL_KEYPAIRS_B58_JSON.length > 0;
    if (hasEndpoints === hasLocalKeys) {
      addPairIssue('ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON', 'ESCROW_ORACLE_LOCAL_KEYPAIRS_B58_JSON');
    }
    if (env.SOLANA_NETWORK === 'mainnet-beta' && hasLocalKeys) {
      addIssue('ESCROW_ORACLE_LOCAL_KEYPAIRS_B58_JSON', 'local oracle keys are forbidden on mainnet');
    }
    const hasMarketAuthorityEndpoint = env.ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON !== undefined;
    const hasMarketAuthorityKey = env.ESCROW_MARKET_AUTHORITY_KEYPAIR_B58 !== undefined;
    if (hasMarketAuthorityEndpoint === hasMarketAuthorityKey) {
      addPairIssue('ESCROW_MARKET_AUTHORITY_KEYPAIR_B58', 'ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON');
    }
    if (env.SOLANA_NETWORK === 'mainnet-beta' && hasMarketAuthorityKey) {
      addIssue('ESCROW_MARKET_AUTHORITY_KEYPAIR_B58', 'local market authority keys are forbidden on mainnet');
    }
    if (env.ESCROW_MARKET_AUTHORITY_KEYPAIR_B58 !== undefined) {
      const forbiddenKeys = [
        env.ESCROW_RELAYER_KEYPAIR_B58, env.ESCROW_FEED_OPERATOR_KEYPAIR_B58,
        ...env.ESCROW_ORACLE_LOCAL_KEYPAIRS_B58_JSON,
      ];
      if (forbiddenKeys.includes(env.ESCROW_MARKET_AUTHORITY_KEYPAIR_B58)) {
        addIssue('ESCROW_MARKET_AUTHORITY_KEYPAIR_B58', 'must use distinct key material');
      }
    }
    if (env.ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON !== undefined) {
      const marketEndpoint = env.ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON;
      const marketOrigin = new URL(marketEndpoint.url).origin;
      if (env.SOLANA_NETWORK === 'mainnet-beta' && marketEndpoint.bearerToken === undefined) {
        addIssue('ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON', 'mainnet signer endpoint must be authenticated');
      }
      if (
        marketEndpoint.bearerToken !== undefined &&
        [env.ESCROW_RELAYER_KEYPAIR_B58, env.ESCROW_FEED_OPERATOR_KEYPAIR_B58,
          ...env.ESCROW_ORACLE_LOCAL_KEYPAIRS_B58_JSON].includes(marketEndpoint.bearerToken)
      ) addIssue('ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON', 'must use distinct credentials');
      if (env.ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON.some((endpoint) =>
        new URL(endpoint.url).origin === marketOrigin ||
        (marketEndpoint.bearerToken !== undefined && endpoint.bearerToken === marketEndpoint.bearerToken)
      )) addIssue('ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON', 'must not reuse oracle credentials');
    }
    if (
      env.ESCROW_CONFIG_AUTHORITY !== undefined &&
      env.ESCROW_ORACLE_SIGNERS.includes(env.ESCROW_CONFIG_AUTHORITY)
    ) addPairIssue('ESCROW_CONFIG_AUTHORITY', 'ESCROW_ORACLE_SIGNERS');
  }
  if (env.ESCROW_MAINNET_ENABLED && (
    env.DEPLOYMENT_ENV !== 'production' ||
    env.SOLANA_NETWORK !== 'mainnet-beta' ||
    env.WAGER_CUSTODY_MODE !== 'escrow'
  )) {
    addIssue('ESCROW_MAINNET_ENABLED', 'requires production mainnet escrow custody');
  }
  if (
    env.SOLANA_NETWORK === 'mainnet-beta' &&
    env.WAGER_CUSTODY_MODE === 'escrow' &&
    !env.ESCROW_MAINNET_ENABLED
  ) {
    addIssue('ESCROW_MAINNET_ENABLED', 'must be explicitly enabled for mainnet escrow custody');
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

}).transform((env) => {
  return {
    ...env,
    WAGER_RUNTIME_MODE: resolvedWagerRuntimeMode(env),
    GLM_BASE_URL: env.GLM_BASE_URL ?? 'https://api.z.ai/api/anthropic',
    SOLANA_RPC_URL: env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
  };
});

export type Env = z.infer<typeof EnvSchema>;

export class EngineEnvironmentError extends Error {
  readonly name = 'EngineEnvironmentError';

  constructor(readonly variables: readonly string[]) {
    super(`Engine environment invalid: ${variables.join(', ')}`);
  }
}

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
