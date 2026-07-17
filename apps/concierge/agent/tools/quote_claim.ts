import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { engineApi, telegramIdentity, NOT_TELEGRAM } from '../lib/engine-api.js';

export default defineTool({
  description:
    'Price a football claim exactly as a member said it ("France score 2 today", "Spain win it"). Read-only: returns the compiled line(s) with live prices and trust tier, or a clarify question, or a rejection. No SOL or position changes.',
  inputSchema: z.object({
    text: z
      .string()
      .min(3)
      .max(400)
      .describe("The claim in the member's own words, verbatim — do not rephrase it."),
  }),
  async execute({ text }, ctx) {
    const id = telegramIdentity(ctx.session);
    if (!id) return NOT_TELEGRAM;
    return engineApi.quote(id.chatId, text);
  },
});
