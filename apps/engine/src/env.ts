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
