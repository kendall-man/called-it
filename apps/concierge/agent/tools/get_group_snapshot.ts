import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { engineApi, telegramIdentity, NOT_TELEGRAM } from '../lib/engine-api.js';

export default defineTool({
  description:
    "What's happening in this group right now: every open call with its terms, price, and back/doubt counts, plus the Rep leaderboard. Use before answering 'what's open', 'any action?', or anything needing a marketId.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const id = telegramIdentity(ctx.session);
    if (!id) return NOT_TELEGRAM;
    return engineApi.snapshot(id.chatId);
  },
});
