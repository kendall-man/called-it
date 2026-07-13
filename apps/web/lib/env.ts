import { z } from 'zod';
import { tokenFingerprint } from './token-fingerprint';

const BooleanSchema = z.enum(['true', 'false']).default('false').transform(
  (value) => value === 'true',
);
const BotUsernameSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_]{3,30}[Bb][Oo][Tt]$/,
);
const DomainSchema = z.string().regex(
  /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/,
);
const Base64KeyPattern = /^[A-Za-z0-9+/]{43}=$/;
const Sha256FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Base64KeySchema = z.string().refine((value) => {
  if (!Base64KeyPattern.test(value)) return false;
  const decoded = atob(value);
  return decoded.length === 32 && btoa(decoded) === value;
});
const PrivyAppIdSchema = z.string().length(25);
const PrivyClientIdSchema = z.string().min(1).max(255);

const WebEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_SOLANA_NETWORK: z.enum(['devnet', 'mainnet-beta']).default('devnet'),
  NEXT_PUBLIC_SOLANA_RPC_URL: z.string().url().optional(),
  NEXT_PUBLIC_TXORACLE_PROGRAM_ID: z.string().min(32).optional(),
  NEXT_PUBLIC_WAGER_TREASURY_PUBKEY: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/).optional(),
  NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: BotUsernameSchema.optional(),
  NEXT_PUBLIC_TELEGRAM_STARTGROUP: z.literal('calledit_v1').optional(),
  NEXT_PUBLIC_PRIVY_APP_ID: PrivyAppIdSchema.optional(),
  NEXT_PUBLIC_PRIVY_CLIENT_ID: PrivyClientIdSchema.optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SOLANA_RPC_URL: z.string().url().optional(),
  CONCIERGE_WALLET_API_URL: z.string().url().optional(),
  WEB_CONCIERGE_TOKEN: z.string().min(32).optional(),
  ENGINE_CONCIERGE_TOKEN_SHA256: Sha256FingerprintSchema.optional(),
  ENGINE_TELEGRAM_TOKEN_SHA256: Sha256FingerprintSchema.optional(),
  ENGINE_OPS_TOKEN_SHA256: Sha256FingerprintSchema.optional(),
  WEB_BASE_URL: z.string().url().optional(),
  WALLET_LINK_DOMAIN: DomainSchema.optional(),
  PRIVY_APP_ID: PrivyAppIdSchema.optional(),
  PRIVY_APP_SECRET: z.string().min(1).optional(),
  PRIVY_JWT_VERIFICATION_KEY: z.string().min(1).optional(),
  ANALYTICS_HMAC_SECRET: Base64KeySchema.optional(),
  STARTER_GRANTS_ENABLED: BooleanSchema,
  WALLET_MINIAPP_ENABLED: BooleanSchema,
  WALLET_PROVIDER: z.enum(['disabled', 'privy']).default('disabled'),
  STAKE_ACCEPTANCE_ENABLED: BooleanSchema,
  NEXT_PUBLIC_WEB_CONCIERGE_TOKEN: z.never().optional(),
  NEXT_PUBLIC_ACCOUNT_SESSION_KEY_CURRENT: z.never().optional(),
  NEXT_PUBLIC_ACCOUNT_SESSION_KEY_PREVIOUS: z.never().optional(),
  NEXT_PUBLIC_ANALYTICS_HMAC_SECRET: z.never().optional(),
  NEXT_PUBLIC_PRIVY_APP_SECRET: z.never().optional(),
  NEXT_PUBLIC_PRIVY_JWT_VERIFICATION_KEY: z.never().optional(),
}).superRefine((env, ctx) => {
  const addPairIssue = (left: string, right: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [left], message: 'invalid relationship' });
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [right], message: 'invalid relationship' });
  };
  const isOrigin = (value: string): boolean => {
    const url = new URL(value);
    return (
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname === '/'
    );
  };
  if (env.NODE_ENV === 'production') {
    if (env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEXT_PUBLIC_TELEGRAM_BOT_USERNAME'],
        message: 'required for production',
      });
    }
    if (env.NEXT_PUBLIC_TELEGRAM_STARTGROUP === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEXT_PUBLIC_TELEGRAM_STARTGROUP'],
        message: 'required for production',
      });
    }
    if (env.WEB_BASE_URL !== undefined && new URL(env.WEB_BASE_URL).protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WEB_BASE_URL'],
        message: 'HTTPS required for production',
      });
    }
    if (
      env.CONCIERGE_WALLET_API_URL !== undefined &&
      new URL(env.CONCIERGE_WALLET_API_URL).protocol !== 'https:'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CONCIERGE_WALLET_API_URL'],
        message: 'HTTPS required for production',
      });
    }
  }

  if (
    env.CONCIERGE_WALLET_API_URL !== undefined &&
    !isOrigin(env.CONCIERGE_WALLET_API_URL)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CONCIERGE_WALLET_API_URL'],
      message: 'origin required',
    });
  }
  if (env.WEB_BASE_URL !== undefined && !isOrigin(env.WEB_BASE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WEB_BASE_URL'],
      message: 'origin required',
    });
  }

  const hasSupabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL !== undefined;
  const hasSupabaseKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== undefined;
  if (hasSupabaseUrl !== hasSupabaseKey) {
    addPairIssue('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }
  const hasSolanaUrl = env.NEXT_PUBLIC_SOLANA_RPC_URL !== undefined;
  const hasProgramId = env.NEXT_PUBLIC_TXORACLE_PROGRAM_ID !== undefined;
  if (hasSolanaUrl !== hasProgramId) {
    addPairIssue('NEXT_PUBLIC_SOLANA_RPC_URL', 'NEXT_PUBLIC_TXORACLE_PROGRAM_ID');
  }
  if (
    env.NEXT_PUBLIC_SOLANA_NETWORK === 'mainnet-beta'
    && env.NEXT_PUBLIC_SOLANA_RPC_URL !== undefined
    && /(?:^|[.\-_/?=&])devnet(?:[.\-_/?=&]|$)/i.test(env.NEXT_PUBLIC_SOLANA_RPC_URL)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['NEXT_PUBLIC_SOLANA_RPC_URL'],
      message: 'mainnet requires a non-devnet RPC URL',
    });
  }

  const walletVariables = [
    ['SUPABASE_URL', env.SUPABASE_URL],
    ['SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY],
    ['WEB_BASE_URL', env.WEB_BASE_URL],
    ['WALLET_LINK_DOMAIN', env.WALLET_LINK_DOMAIN],
    ['SOLANA_RPC_URL', env.SOLANA_RPC_URL],
    ['NEXT_PUBLIC_WAGER_TREASURY_PUBKEY', env.NEXT_PUBLIC_WAGER_TREASURY_PUBKEY],
    ['NEXT_PUBLIC_PRIVY_APP_ID', env.NEXT_PUBLIC_PRIVY_APP_ID],
    ['PRIVY_APP_ID', env.PRIVY_APP_ID],
    ['PRIVY_APP_SECRET', env.PRIVY_APP_SECRET],
    ['PRIVY_JWT_VERIFICATION_KEY', env.PRIVY_JWT_VERIFICATION_KEY],
    ['WALLET_PROVIDER', env.WALLET_PROVIDER === 'privy' ? env.WALLET_PROVIDER : undefined],
  ] as const;
  if (env.WALLET_MINIAPP_ENABLED) {
    for (const [name, value] of walletVariables) {
      if (value === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'required' });
      }
    }
  }
  if (
    env.NEXT_PUBLIC_PRIVY_APP_ID !== undefined &&
    env.PRIVY_APP_ID !== undefined &&
    env.NEXT_PUBLIC_PRIVY_APP_ID !== env.PRIVY_APP_ID
  ) {
    addPairIssue('NEXT_PUBLIC_PRIVY_APP_ID', 'PRIVY_APP_ID');
  }
  if (!env.WALLET_MINIAPP_ENABLED && env.WALLET_PROVIDER === 'privy') {
    addPairIssue('WALLET_MINIAPP_ENABLED', 'WALLET_PROVIDER');
  }
  if (
    env.WEB_BASE_URL !== undefined &&
    env.WALLET_LINK_DOMAIN !== undefined &&
    new URL(env.WEB_BASE_URL).hostname !== env.WALLET_LINK_DOMAIN
  ) {
    addPairIssue('WALLET_LINK_DOMAIN', 'WEB_BASE_URL');
  }
  if (env.STARTER_GRANTS_ENABLED && !env.STAKE_ACCEPTANCE_ENABLED) {
    addPairIssue('STARTER_GRANTS_ENABLED', 'STAKE_ACCEPTANCE_ENABLED');
  }
  const routeFingerprints = [
    ['ENGINE_CONCIERGE_TOKEN', 'ENGINE_CONCIERGE_TOKEN_SHA256', env.ENGINE_CONCIERGE_TOKEN_SHA256],
    ['ENGINE_TELEGRAM_TOKEN', 'ENGINE_TELEGRAM_TOKEN_SHA256', env.ENGINE_TELEGRAM_TOKEN_SHA256],
    ['ENGINE_OPS_TOKEN', 'ENGINE_OPS_TOKEN_SHA256', env.ENGINE_OPS_TOKEN_SHA256],
  ] as const;
  if (env.WEB_CONCIERGE_TOKEN !== undefined) {
    for (const [_tokenName, fingerprintName, fingerprint] of routeFingerprints) {
      if (fingerprint === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [fingerprintName], message: 'required' });
      }
    }
  }
  const webTokenFingerprint = env.WEB_CONCIERGE_TOKEN === undefined
    ? undefined
    : tokenFingerprint(env.WEB_CONCIERGE_TOKEN);
  for (const [name, _fingerprintName, fingerprint] of routeFingerprints) {
    if (webTokenFingerprint !== undefined && fingerprint === webTokenFingerprint) {
      addPairIssue(name, 'WEB_CONCIERGE_TOKEN');
    }
  }
}).transform((env) => {
  const {
    ENGINE_CONCIERGE_TOKEN_SHA256: _conciergeAuditOnly,
    ENGINE_TELEGRAM_TOKEN_SHA256: _telegramAuditOnly,
    ENGINE_OPS_TOKEN_SHA256: _opsAuditOnly,
    ...runtime
  } = env;
  return runtime;
});

export type WebEnv = Readonly<z.infer<typeof WebEnvSchema>>;

export type SupabasePublicConfig = {
  readonly url: string;
  readonly anonKey: string;
};

export type SolanaPublicConfig = {
  readonly rpcUrl: string;
  readonly programId: string;
};

export class WebEnvironmentError extends Error {
  readonly name = 'WebEnvironmentError';

  constructor(readonly variables: readonly string[]) {
    super(`Web environment invalid: ${variables.join(', ')}`);
  }
}

export function loadWebEnv(source: NodeJS.ProcessEnv = process.env): WebEnv {
  const parsed = WebEnvSchema.safeParse(source);
  if (!parsed.success) {
    const variables = [...new Set(
      parsed.error.issues.map((issue) => String(issue.path[0] ?? '(root)')),
    )].sort();
    throw new WebEnvironmentError(variables);
  }
  return parsed.data;
}

export function validateWebBuildEnv(source: NodeJS.ProcessEnv = process.env): void {
  loadWebEnv(source);
}

export function getSupabaseConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function getSolanaConfig(): SolanaPublicConfig | null {
  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  const programId = process.env.NEXT_PUBLIC_TXORACLE_PROGRAM_ID;
  if (!rpcUrl || !programId) return null;
  return { rpcUrl, programId };
}
