import { z } from 'zod';

/**
 * Environment contract — exactly the names declared in the repo-root
 * `.env.example`. The engine refuses to boot on an invalid environment so a
 * misconfigured deploy fails loudly instead of half-working.
 */
const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, 'BotFather token required'),
  GLM_API_KEY: z.string().min(1, 'GLM (Z.ai) key required for the agent'),
  GLM_BASE_URL: z.string().url().default('https://api.z.ai/api/anthropic'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TXLINE_API_BASE: z.string().url(),
  TXLINE_GUEST_JWT: z.string().min(1),
  TXLINE_API_TOKEN: z.string().min(1),
  SOLANA_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
  /** Optional: without it the proof worker degrades to "unavailable" badges. */
  SOLANA_KEYPAIR_B58: z.string().optional(),
  TXORACLE_PROGRAM_ID: z.string().min(32),
  TXL_MINT: z.string().min(32),
  WEB_BASE_URL: z.string().url(),
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
  WAGER_MODE_ENABLED: z.string().default('false'),
  /**
   * Dedicated plain-SOL treasury for wager mode. NEVER the TxL-holding
   * SOLANA_KEYPAIR_B58 (sponsor terms: TxL is never wagering collateral).
   * Absent → the wager module degrades to null exactly like the flag being off.
   */
  WAGER_TREASURY_KEYPAIR_B58: z.string().optional(),
  /** Optional ops chat for wager solvency alerts. */
  WAGER_OPS_CHAT_ID: z.string().optional(),
  /**
   * STAGING-ONLY: play-money lamports auto-credited on a user's first stake
   * ("no real devnet" mode — nobody needs a wallet or a faucet). 0 = off;
   * must stay 0/unset anywhere production-like.
   */
  WAGER_STAGING_GRANT_LAMPORTS: z.coerce.bigint().nonnegative().default(0n),
}).superRefine((env, ctx) => {
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

});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Engine cannot boot — invalid environment:\n${problems}`);
  }
  return parsed.data;
}
