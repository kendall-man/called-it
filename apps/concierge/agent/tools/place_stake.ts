import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { engineApi, telegramIdentity, NOT_TELEGRAM } from '../lib/engine-api.js';

/**
 * Stakes at or above this pause for an inline-keyboard confirm (Telegram
 * renders the approval natively). Below it, a clean explicit ask goes straight
 * through — points product, so ceremony only where a misparse would sting.
 * 100 is the per-market cap, so this catches exactly the all-in moves.
 */
const CONFIRM_AT_OR_ABOVE = 100;

export default defineTool({
  description:
    'Put Rep on an open market for the member speaking: back it (they say it happens) or doubt it. Only on an explicit ask with a clear side and amount. The stake locks the current multiplier. Guards (balance, per-market cap, one-side rule, kickoff cutoff) are enforced downstream — relay any refusal honestly.',
  inputSchema: z.object({
    marketId: z.string().uuid().describe('From get_group_snapshot or quote flow — never invented.'),
    side: z.enum(['back', 'doubt']),
    amount: z.number().int().positive().max(1000).describe('Whole Rep, exactly as the member asked.'),
  }),
  approval: ({ toolInput }) =>
    ((toolInput as { amount?: number } | undefined)?.amount ?? 0) >= CONFIRM_AT_OR_ABOVE
      ? 'user-approval'
      : 'not-applicable',
  async execute({ marketId, side, amount }, ctx) {
    const id = telegramIdentity(ctx.session);
    if (!id) return NOT_TELEGRAM;
    return engineApi.stake({
      chatId: id.chatId,
      marketId,
      // Identity comes from the session principal (webhook-derived), never
      // from model input — nobody can stake as someone else by naming them.
      userId: id.userId,
      displayName: id.username ?? `Player ${String(id.userId).slice(-4)}`,
      username: id.username,
      side,
      amount,
      // eve re-runs interrupted steps; the engine dedupes on the call id so a
      // replayed step can never double-stake.
      idempotencyKey: ctx.callId,
    });
  },
});
