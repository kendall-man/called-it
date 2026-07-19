import { describe, expect, it } from 'vitest';
import { MARKET_ID, createSettlementHarness } from './group-points-settlement.test-support.js';

/**
 * With STAKE_LADDER_ENABLED the settlement board is the FINAL edit of the same
 * card message and one compact ping (reply to the card) carries the sole
 * notification. Net new-message count stays at one, as in the flag-off receipt.
 */
describe('settlement board (STAKE_LADDER_ENABLED)', () => {
  it('edits the card into the board and sends one compact settlement ping', async () => {
    const harness = await createSettlementHarness({ market: { card_tg_message_id: 900 } });
    Object.assign(harness.deps.env, { STAKE_LADDER_ENABLED: true });

    await harness.settler.postReceipt(harness.market, 'claim_won');
    await harness.queue.idle();

    // The board (full receipt) lands as the card edit…
    expect(harness.telegram.texts.some((text) => text.includes('🏁 RESULT'))).toBe(true);
    // …and exactly one compact ping notifies, hype-free, linking the board.
    const pings = harness.telegram.texts.filter((text) => text.startsWith('Called it. Settled.'));
    expect(pings).toHaveLength(1);
    expect(pings[0]).not.toContain('!');
    // At-least-once persistence still runs on the ping's send.
    expect(harness.markedMarketIds).toEqual([MARKET_ID]);
  });
});
