import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { engineApi, telegramIdentity, NOT_TELEGRAM } from '../lib/engine-api.js';

/**
 * Real devnet SOL changes hands, so every stake pauses for a native Telegram
 * inline-keyboard confirm — a misparse here costs the member their stack. 0.1
 * SOL is the per-market cap; a stake there is the biggest a member can make.
 */
const MAX_STAKE_SOL = 0.1;

export default defineTool({
  description:
    "Place a devnet-SOL bet on an open market for the member speaking: back it (they say it happens) or bet against it. Only on an explicit ask with a clear side and amount in SOL. Guards (balance, per-market cap, one-side rule, kickoff cutoff) are enforced downstream — relay the returned reply honestly.",
  inputSchema: z.object({
    marketId: z.string().uuid().describe('From get_group_snapshot or quote flow — never invented.'),
    side: z.enum(['back', 'doubt']).describe("'back' = it happens, 'doubt' = bet against."),
    amount: z
      .number()
      .positive()
      .max(MAX_STAKE_SOL)
      .describe('Devnet SOL, e.g. 0.05, exactly as the member asked. Max 0.1 per market.'),
  }),
  // Real money on devnet — always confirm the exact side and amount.
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
