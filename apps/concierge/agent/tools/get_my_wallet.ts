import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { engineApi, telegramIdentity, NOT_TELEGRAM } from '../lib/engine-api.js';

export default defineTool({
  description:
    "The asking member's own Rep balance and open positions in this group. Always for the person speaking — there is no way to look at someone else's wallet.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const id = telegramIdentity(ctx.session);
    if (!id) return NOT_TELEGRAM;
    return engineApi.wallet(id.chatId, id.userId);
  },
});
