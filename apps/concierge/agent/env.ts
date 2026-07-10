import { z } from 'zod';
import {
  deriveAccountSessionKey,
  type AccountSessionKeyring,
} from './session-keys.js';

const PREVIOUS_KEY_OVERLAP_MS = 10 * 60 * 1_000;
const MillisecondsSchema = z.coerce.number().int().positive().max(86_400_000);
const BooleanSchema = z.enum(['true', 'false']).transform((value) => value === 'true');
const Base64KeySchema = z.string()
  .regex(/^[A-Za-z0-9+/]{43}=$/)
  .refine((value) => Buffer.from(value, 'base64').toString('base64') === value)
  .transform((value) => Buffer.from(value, 'base64'));
const KeyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const RawConciergeEnvSchema = z.object({
  DEPLOYMENT_ENV: z.enum(['development', 'staging', 'production']),
  GLM_API_KEY: z.string().min(1),
  GLM_BASE_URL: z.string().url(),
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{3,30}[Bb][Oo][Tt]$/),
  TELEGRAM_WEBHOOK_SECRET_TOKEN: z.string().min(32),
  ENGINE_PRIVATE_API_URL: z.string().url(),
  ENGINE_CONCIERGE_TOKEN: z.string().min(32),
  ENGINE_TELEGRAM_TOKEN: z.string().min(32),
  ENGINE_OPS_TOKEN: z.string().min(32).optional(),
  WEB_CONCIERGE_TOKEN: z.string().min(32),
  WEB_BASE_URL: z.string().url(),
  WALLET_LINK_DOMAIN: z.string().regex(/^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/),
  ANALYTICS_HMAC_SECRET: Base64KeySchema,
  STARTER_GRANTS_ENABLED: BooleanSchema,
  WALLET_MINIAPP_ENABLED: BooleanSchema,
  STAKE_ACCEPTANCE_ENABLED: BooleanSchema,
  ACCOUNT_SESSION_KEY_CURRENT: Base64KeySchema.optional(),
  ACCOUNT_SESSION_KEY_CURRENT_KID: KeyIdSchema.optional(),
  ACCOUNT_SESSION_KEY_PREVIOUS: Base64KeySchema.optional(),
  ACCOUNT_SESSION_KEY_PREVIOUS_KID: KeyIdSchema.optional(),
  ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT: z.string().datetime({ offset: true }).optional(),
  READINESS_CHECK_TIMEOUT_MS: MillisecondsSchema.max(10_000),
  READINESS_ENGINE_TIMEOUT_MS: MillisecondsSchema.max(10_000),
  SHUTDOWN_DRAIN_TIMEOUT_MS: MillisecondsSchema.max(15_000),
  PORT: z.coerce.number().int().positive().max(65_535),
});

function createConciergeEnvSchema(nowEpochMs: number) {
  return RawConciergeEnvSchema.superRefine((env, ctx) => {
    const addPairIssue = (left: string, right: string): void => {
      ctx.addIssue({ code: 'custom', path: [left], message: 'invalid relationship' });
      ctx.addIssue({ code: 'custom', path: [right], message: 'invalid relationship' });
    };
    const routeTokenPairs = [
      ['ENGINE_CONCIERGE_TOKEN', env.ENGINE_CONCIERGE_TOKEN, 'ENGINE_TELEGRAM_TOKEN', env.ENGINE_TELEGRAM_TOKEN],
      ['ENGINE_CONCIERGE_TOKEN', env.ENGINE_CONCIERGE_TOKEN, 'ENGINE_OPS_TOKEN', env.ENGINE_OPS_TOKEN],
      ['ENGINE_CONCIERGE_TOKEN', env.ENGINE_CONCIERGE_TOKEN, 'WEB_CONCIERGE_TOKEN', env.WEB_CONCIERGE_TOKEN],
      ['ENGINE_TELEGRAM_TOKEN', env.ENGINE_TELEGRAM_TOKEN, 'ENGINE_OPS_TOKEN', env.ENGINE_OPS_TOKEN],
      ['ENGINE_TELEGRAM_TOKEN', env.ENGINE_TELEGRAM_TOKEN, 'WEB_CONCIERGE_TOKEN', env.WEB_CONCIERGE_TOKEN],
      ['ENGINE_OPS_TOKEN', env.ENGINE_OPS_TOKEN, 'WEB_CONCIERGE_TOKEN', env.WEB_CONCIERGE_TOKEN],
    ] as const;
    for (const [leftName, leftToken, rightName, rightToken] of routeTokenPairs) {
      if (leftToken !== undefined && leftToken === rightToken) {
        addPairIssue(leftName, rightName);
      }
    }

    const webUrl = new URL(env.WEB_BASE_URL);
    const engineUrl = new URL(env.ENGINE_PRIVATE_API_URL);
    const deployed = env.DEPLOYMENT_ENV !== 'development';
    if (deployed && webUrl.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', path: ['WEB_BASE_URL'], message: 'HTTPS required' });
    }
    if (deployed && new URL(env.GLM_BASE_URL).protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', path: ['GLM_BASE_URL'], message: 'HTTPS required' });
    }
    if (deployed && !engineUrl.hostname.endsWith('.railway.internal')) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENGINE_PRIVATE_API_URL'],
        message: 'Railway private host required',
      });
    }
    if (
      engineUrl.username !== '' ||
      engineUrl.password !== '' ||
      engineUrl.search !== '' ||
      engineUrl.hash !== '' ||
      (engineUrl.pathname !== '' && engineUrl.pathname !== '/')
    ) {
      ctx.addIssue({ code: 'custom', path: ['ENGINE_PRIVATE_API_URL'], message: 'origin required' });
    }
    if (webUrl.hostname !== env.WALLET_LINK_DOMAIN) {
      addPairIssue('WALLET_LINK_DOMAIN', 'WEB_BASE_URL');
    }

    if (env.STARTER_GRANTS_ENABLED && !env.STAKE_ACCEPTANCE_ENABLED) {
      addPairIssue('STARTER_GRANTS_ENABLED', 'STAKE_ACCEPTANCE_ENABLED');
    }
    if (env.WALLET_MINIAPP_ENABLED) {
      if (env.ACCOUNT_SESSION_KEY_CURRENT === undefined) {
        ctx.addIssue({ code: 'custom', path: ['ACCOUNT_SESSION_KEY_CURRENT'], message: 'required' });
      }
      if (env.ACCOUNT_SESSION_KEY_CURRENT_KID === undefined) {
        ctx.addIssue({ code: 'custom', path: ['ACCOUNT_SESSION_KEY_CURRENT_KID'], message: 'required' });
      }
    }

    const hasCurrentKey = env.ACCOUNT_SESSION_KEY_CURRENT !== undefined;
    const hasCurrentKid = env.ACCOUNT_SESSION_KEY_CURRENT_KID !== undefined;
    if (hasCurrentKey !== hasCurrentKid) {
      addPairIssue('ACCOUNT_SESSION_KEY_CURRENT', 'ACCOUNT_SESSION_KEY_CURRENT_KID');
    }

    const hasPreviousKey = env.ACCOUNT_SESSION_KEY_PREVIOUS !== undefined;
    const hasPreviousKid = env.ACCOUNT_SESSION_KEY_PREVIOUS_KID !== undefined;
    const hasPreviousExpiry = env.ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT !== undefined;
    const hasAnyPrevious = hasPreviousKey || hasPreviousKid || hasPreviousExpiry;
    if (hasAnyPrevious && !hasPreviousKey) {
      ctx.addIssue({ code: 'custom', path: ['ACCOUNT_SESSION_KEY_PREVIOUS'], message: 'required' });
    }
    if (hasAnyPrevious && !hasPreviousKid) {
      ctx.addIssue({ code: 'custom', path: ['ACCOUNT_SESSION_KEY_PREVIOUS_KID'], message: 'required' });
    }
    if (hasAnyPrevious && !hasPreviousExpiry) {
      ctx.addIssue({ code: 'custom', path: ['ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT'], message: 'required' });
    }
    if (hasAnyPrevious && (!hasCurrentKey || !hasCurrentKid)) {
      ctx.addIssue({ code: 'custom', path: ['ACCOUNT_SESSION_KEY_CURRENT'], message: 'required' });
      ctx.addIssue({ code: 'custom', path: ['ACCOUNT_SESSION_KEY_CURRENT_KID'], message: 'required' });
    }
    if (
      env.ACCOUNT_SESSION_KEY_CURRENT !== undefined &&
      env.ACCOUNT_SESSION_KEY_PREVIOUS !== undefined &&
      env.ACCOUNT_SESSION_KEY_CURRENT.equals(env.ACCOUNT_SESSION_KEY_PREVIOUS)
    ) {
      addPairIssue('ACCOUNT_SESSION_KEY_CURRENT', 'ACCOUNT_SESSION_KEY_PREVIOUS');
    }
    if (
      env.ACCOUNT_SESSION_KEY_CURRENT_KID !== undefined &&
      env.ACCOUNT_SESSION_KEY_PREVIOUS_KID !== undefined &&
      env.ACCOUNT_SESSION_KEY_CURRENT_KID === env.ACCOUNT_SESSION_KEY_PREVIOUS_KID
    ) {
      addPairIssue('ACCOUNT_SESSION_KEY_CURRENT_KID', 'ACCOUNT_SESSION_KEY_PREVIOUS_KID');
    }
    if (env.ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT !== undefined) {
      const expiresAt = Date.parse(env.ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT);
      if (expiresAt <= nowEpochMs || expiresAt > nowEpochMs + PREVIOUS_KEY_OVERLAP_MS) {
        ctx.addIssue({
          code: 'custom',
          path: ['ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT'],
          message: 'outside overlap',
        });
      }
    }

    if (env.READINESS_ENGINE_TIMEOUT_MS >= env.READINESS_CHECK_TIMEOUT_MS) {
      addPairIssue('READINESS_ENGINE_TIMEOUT_MS', 'READINESS_CHECK_TIMEOUT_MS');
    }
    if (env.READINESS_CHECK_TIMEOUT_MS >= env.SHUTDOWN_DRAIN_TIMEOUT_MS) {
      addPairIssue('READINESS_CHECK_TIMEOUT_MS', 'SHUTDOWN_DRAIN_TIMEOUT_MS');
    }
  }).transform((env) => {
    const {
      ACCOUNT_SESSION_KEY_CURRENT,
      ACCOUNT_SESSION_KEY_CURRENT_KID,
      ACCOUNT_SESSION_KEY_PREVIOUS,
      ACCOUNT_SESSION_KEY_PREVIOUS_KID,
      ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT,
      ENGINE_OPS_TOKEN: _auditOnly,
      ...runtime
    } = env;
    let keyring: AccountSessionKeyring | null = null;
    if (
      ACCOUNT_SESSION_KEY_CURRENT !== undefined &&
      ACCOUNT_SESSION_KEY_CURRENT_KID !== undefined
    ) {
      const current = deriveAccountSessionKey(
        ACCOUNT_SESSION_KEY_CURRENT,
        ACCOUNT_SESSION_KEY_CURRENT_KID,
      );
      const previous =
        ACCOUNT_SESSION_KEY_PREVIOUS !== undefined &&
        ACCOUNT_SESSION_KEY_PREVIOUS_KID !== undefined &&
        ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT !== undefined
          ? {
              ...deriveAccountSessionKey(
                ACCOUNT_SESSION_KEY_PREVIOUS,
                ACCOUNT_SESSION_KEY_PREVIOUS_KID,
              ),
              acceptUntilEpochMs: Date.parse(ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT),
            }
          : null;
      keyring = { current, previous };
    }
    return { ...runtime, ACCOUNT_SESSION_KEYRING: keyring };
  });
}

export type ConciergeEnv = Readonly<
  z.output<ReturnType<typeof createConciergeEnvSchema>>
>;

export class ConciergeEnvironmentError extends Error {
  readonly name = 'ConciergeEnvironmentError';

  constructor(readonly variables: readonly string[]) {
    super(`Concierge environment invalid: ${variables.join(', ')}`);
  }
}

export function loadConciergeEnv(
  source: NodeJS.ProcessEnv = process.env,
  nowEpochMs: number = Date.now(),
): ConciergeEnv {
  const parsed = createConciergeEnvSchema(nowEpochMs).safeParse(source);
  if (!parsed.success) {
    const variables = [...new Set(
      parsed.error.issues.map((issue) => String(issue.path[0] ?? '(root)')),
    )].sort();
    throw new ConciergeEnvironmentError(variables);
  }
  return parsed.data;
}
