import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { engineApi } from '../lib/engine-api.js';

const MAX_WINDOW_HOURS = 168;

export default defineTool({
  description:
    "Fixtures on the feed: what's playing now and kicking off soon (default next 48 hours). Use for 'what's on today', or to find the match a claim is about.",
  inputSchema: z.object({
    hours: z.number().int().positive().max(MAX_WINDOW_HOURS).optional()
      .describe('Look-ahead window in hours; default 48.'),
  }),
  async execute({ hours }) {
    return engineApi.fixtures(hours);
  },
});
