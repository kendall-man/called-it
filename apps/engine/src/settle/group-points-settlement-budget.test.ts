import { describe, expect, it } from 'vitest';
import { renderFallback, type Say } from '../bot/copy.js';
import type { PostOptions, Poster } from '../bot/poster.js';
import type { GroupPointsService } from '../points/service.js';
import { TELEGRAM_MESSAGE_LIMIT } from '../points/presentation.js';
import { Settler } from './settler.js';
import { createSettlementHarness } from './group-points-settlement.test-support.js';
import { testWager } from './group-points-settlement-recovery.test-support.js';
import { encodeReceiptId } from '../pipeline/receipt-id.js';

const BROKEN_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const PAYOUT = 'FINAL PAYOUT: 0.08 SOL. (devnet)';
const IDENTITY = { username: null, displayName: '🏆'.repeat(100) };
const LEADERBOARD = Array.from({ length: 5 }, (_, index) => ({
  ...IDENTITY, points: 50 - index * 10, wins: 5 - index, losses: index,
}));

class LimitPoster implements Poster {
  readonly texts: string[] = [];
  attempts = 0;
  private completion: Promise<void> = Promise.resolve();

  post(_chatId: number, text: string, options?: PostOptions): void {
    this.attempts += 1;
    this.texts.push(text);
    if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
      this.completion = options?.onSent?.(this.attempts) ?? Promise.resolve();
    }
  }

  editCard(): void {}
  stripKeyboard(): void {}
  react(): void {}
  chatAction(): void {}
  idle(): Promise<void> { return this.completion; }
}

async function adversarialReceipt() {
  const harness = await createSettlementHarness({
    wager: (timeline) => testWager(timeline, PAYOUT),
  });
  const claim = await harness.deps.db.getClaim(harness.market.claim_id);
  if (claim === null) throw new TypeError('Settlement test claim is missing');
  Object.assign(harness.deps.db, {
    getClaim: async () => ({ ...claim, quoted_text: '🏆'.repeat(3_000) }),
    getUser: async (id: number) => ({
      id, display_name: '🏆'.repeat(3_000), username: null,
    }),
  });
  const points: GroupPointsService = {
    apply: async () => ({
      eligible: true, duplicate: false, marketId: harness.market.id,
      groupId: harness.market.group_id, scoredCount: 100, winnerCount: 60,
      winners: Array.from({ length: 10 }, () => IDENTITY),
      misses: Array.from({ length: 10 }, () => IDENTITY), leaderboard: LEADERBOARD,
    }),
  };
  const poster = new LimitPoster();
  const say: Say = async (key, vars = {}) => renderFallback(key, vars);
  const settler = new Settler(harness.deps, poster, say, points, null);
  await settler.postReceipt(harness.market, 'claim_won');
  await poster.idle();
  if (harness.markedMarketIds.length === 0) {
    await settler.postReceipt(harness.market, 'claim_won');
    await poster.idle();
  }
  return { harness, poster, text: poster.texts[0] ?? '' };
}

describe('group points settlement Telegram budget', () => {
  it('marks one bounded send so settlement recovery does not retry oversize', async () => {
    const { harness, poster, text } = await adversarialReceipt();

    expect(poster.attempts).toBe(1);
    expect(harness.markedMarketIds).toEqual([harness.market.id]);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(text).not.toMatch(BROKEN_SURROGATE);
  });

  it('preserves authoritative overflow, payout, compact trust, and receipt lines', async () => {
    const { harness, text } = await adversarialReceipt();
    const label = '🏆'.repeat(32);
    const ten = Array.from({ length: 10 }, () => label).join(', ');
    const mandatoryLines = [
      `💠 ${PAYOUT}`,
      `Winners (+10 points): ${ten}, and 50 more`,
      `Misses (+0 points): ${ten}, and 30 more`,
      '🔏 Oracle-resolved · Signed data feed',
      `Receipt: https://web.invalid/r/${encodeReceiptId(harness.market.id)}`,
    ];

    for (const line of mandatoryLines) expect(text).toContain(line);
    expect(text).not.toContain('Group leaderboard');
  });
});
