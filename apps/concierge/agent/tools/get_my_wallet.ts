import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { engineApi, telegramIdentity, NOT_TELEGRAM } from '../lib/engine-api.js';

export default defineTool({
  description:
    "The asking member's own test-SOL balance, linked wallet, and open positions in this group. Test SOL has no monetary value. Always use the speaking member's account; another member's account is never available.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const id = telegramIdentity(ctx.session);
    if (!id) return NOT_TELEGRAM;
    return engineApi.wallet(id.chatId, id.userId);
  },
});
