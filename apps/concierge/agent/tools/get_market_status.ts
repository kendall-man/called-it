import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { engineApi } from '../lib/engine-api.js';

export default defineTool({
  description:
    'One market by id: current status (open / frozen / settled / voided), terms, price, trust tier, and the public receipt link. Use for "did it settle?", "show the receipt", "is it still open?".',
  inputSchema: z.object({
    marketId: z.string().uuid(),
  }),
  async execute({ marketId }) {
    return engineApi.market(marketId);
  },
});
