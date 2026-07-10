import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { engineApi, telegramIdentity, NOT_TELEGRAM } from '../lib/engine-api.js';

/**
 * Test SOL has no monetary value, but every position still pauses for native
 * Telegram confirmation. The 0.1 SOL per-market cap is enforced downstream.
 */
const MAX_STAKE_SOL = 0.1;

export default defineTool({
  description:
    'Record a test-SOL position on an open call for the member speaking: it happens or it does not. Act only on an explicit request with a clear choice and amount. Balance, cap, one-side, and kickoff guards are enforced downstream; relay the returned state exactly.',
  inputSchema: z.object({
    marketId: z.string().uuid().describe('From get_group_snapshot or quote flow — never invented.'),
    side: z.enum(['back', 'doubt']).describe("'back' = it happens, 'doubt' = bet against."),
    amount: z
      .number()
      .positive()
      .max(MAX_STAKE_SOL)
      .describe('Test SOL on devnet, e.g. 0.05, exactly as the member asked. Max 0.1 per market.'),
  }),
  approval: () => 'user-approval',
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
