import { describe, expect, it } from 'vitest';
import type { TelegramCall } from './telegram-points-flow-telegram.test-support.js';
import { TEST_BOT_TOKEN } from './telegram-points-flow-telegram.test-support.js';
import { TelegramPointsFlowHarness } from './telegram-points-flow.test-support.js';
import { RUNTIME_TELEGRAM_TOKEN_SENTINEL } from './telegram-points-flow-runtime.test-support.js';
import { WALLET_ADDRESS_SENTINEL } from './telegram-points-flow-wager.test-support.js';
import { encodeReceiptId } from '../pipeline/receipt-id.js';
import {
  ALICE_ID,
  BOB_ID,
  CALLER_ID,
  CARA_ID,
  GROUP_ONE_ID,
  GROUP_TWO_ID,
} from './telegram-points-flow-fixtures.test-support.js';

class MissingObservation extends Error {
  readonly name = 'MissingObservation';
  constructor(readonly observation: string) { super(`Missing flow observation: ${observation}`); }
}

function requiredCall(
  calls: readonly TelegramCall[],
  predicate: (call: TelegramCall) => boolean,
  name: string,
): TelegramCall {
  const call = calls.find(predicate);
  if (call === undefined) throw new MissingObservation(name);
  return call;
}

function marketReceipt(calls: readonly TelegramCall[], marketId: string): TelegramCall {
  const receiptId = encodeReceiptId(marketId);
  if (receiptId === null) throw new MissingObservation(`receipt-id:${marketId}`);
  return requiredCall(
    calls,
    (call) => call.text?.includes('🏁 RESULT') === true && call.text.includes(receiptId),
    `receipt:${marketId}`,
  );
}

describe('Telegram group points flow', () => {
  it('recovers a duplicate retry through the persisted unposted-settlement sweep', async () => {
    // Given two groups, deterministic users, and a first live call with two public choices
    const harness = new TelegramPointsFlowHarness();
    const first = await harness.createCall(0);
    harness.preparePoints(first, 'group_one_win', true);
    await harness.tap(first, ALICE_ID, 'back');
    await harness.tap(first, BOB_ID, 'doubt');
    const firstCard = requiredCall(
      harness.runtime.transport.calls,
      (call) => call.method === 'editMessageText'
        && call.text?.includes(encodeReceiptId(first.id) ?? first.id) === true
        && call.text.includes('@alice_calls') && call.text.includes('Draw or loss · 0.01 SOL · Bob'),
      'first populated card',
    );

    // When the atomic point apply succeeds but its first projection read is interrupted
    const outboundBeforeSettlement = harness.runtime.transport.calls.length;
    const terminal = await harness.settle(first, 'claim_won');

    // Then no receipt is posted, while the exact persisted apply/event state survives
    const interrupted = harness.runtime.db.persistedPointState(first.id);
    const scoringBytesBeforeRetry = harness.runtime.db.persistedScoringBytes(first.id);
    expect(interrupted).toEqual({
      marketStatus: 'settled',
      pointsApplied: true,
      pointEvents: [
        { group_id: GROUP_ONE_ID, market_id: first.id, user_id: ALICE_ID, side: 'back', result: 'won', points_delta: 10, display_name: 'Alice', username: 'alice_calls' },
        { group_id: GROUP_ONE_ID, market_id: first.id, user_id: BOB_ID, side: 'doubt', result: 'lost', points_delta: 0, display_name: 'Bob', username: null },
      ],
      settlementPosted: false,
    });
    expect(harness.runtime.transport.calls.slice(outboundBeforeSettlement)
      // Presence traffic (the budget-free settled-claim reaction) is not a
      // message send; this assertion is about the delivery budget.
      .filter((call) => call.method !== 'setMessageReaction' && call.method !== 'sendChatAction')
      .map((call) => ({
        method: call.method,
        chatId: call.chatId,
        locked: call.text?.includes('🚦 Calls locked') === true,
        receipt: call.text?.includes('🏁 RESULT') === true,
      }))).toEqual([
      { method: 'editMessageText', chatId: GROUP_ONE_ID, locked: true, receipt: false },
    ]);
    expect(harness.runtime.log.events.some((event) => event.event === 'group_points_applied')).toBe(false);
    expect(firstCard.chatId).toBe(GROUP_ONE_ID);
    expect(firstCard.text).toContain('Atlas FC to win · 0.01 SOL · @alice_calls');
    expect(firstCard.text).toContain('Draw or loss · 0.01 SOL · Bob');
    expect(firstCard.text).not.toMatch(/It (?:happens|does not):[^\n]*@dee_calls/);

    // When Telegram repeats the terminal update, the real event path deduplicates it
    const outboundAfterTerminal = harness.runtime.transport.calls.length;
    await harness.repeatTerminal(terminal);
    expect(harness.runtime.transport.calls).toHaveLength(outboundAfterTerminal);
    expect(harness.runtime.db.applyCount(first.id)).toBe(1);
    expect(harness.runtime.log.events.filter((event) => event.event === 'feed_event_duplicate')).toHaveLength(1);

    // When the persisted unposted-settlement sweep retries the receipt
    await harness.recoverUnpostedSettlements();
    const recovered = harness.runtime.db.persistedPointState(first.id);
    const firstReceipt = marketReceipt(harness.runtime.transport.calls, first.id);

    // Then the score is unchanged, one receipt follows the successful point read, and SOL stays separate
    expect(recovered).toEqual({ ...interrupted, settlementPosted: true });
    expect(harness.runtime.db.persistedScoringBytes(first.id)).toBe(scoringBytesBeforeRetry);
    expect(harness.runtime.db.applyCount(first.id)).toBe(2);
    expect(harness.runtime.log.events.filter((event) => event.event === 'sweeper_reposting')).toHaveLength(1);
    expect(harness.runtime.log.events.filter((event) => event.event === 'group_points_duplicate')).toHaveLength(1);
    expect(firstReceipt.text).toContain('Winners (+10 points): @alice_calls');
    expect(firstReceipt.text).toContain('Misses (+0 points): Bob');
    expect(firstReceipt.text).toContain('Test-SOL pool settled separately. Test SOL has no monetary value.');
    expect(firstReceipt.text).not.toMatch(/(?:10 points|points).*test SOL|test SOL.*(?:10 points|points)/i);
    const successfulRead = harness.runtime.db.trace.lastIndexOf(`points:read:${first.id}`);
    const receiptSend = harness.runtime.db.trace.findIndex((entry) => entry.startsWith('telegram:sendMessage:CALLED IT.'));
    expect(successfulRead).toBeGreaterThan(-1);
    expect(receiptSend).toBeGreaterThan(successfulRead);
    const outboundAfterRecovery = harness.runtime.transport.calls.length;
    await harness.recoverUnpostedSettlements();
    expect(harness.runtime.transport.calls).toHaveLength(outboundAfterRecovery);
    expect(harness.runtime.db.persistedScoringBytes(first.id)).toBe(scoringBytesBeforeRetry);

    // When a second call loses in group one and the overlapping user wins independently in group two
    const second = await harness.createCall(1);
    harness.preparePoints(second, 'group_one_loss');
    await harness.tap(second, ALICE_ID, 'back');
    await harness.tap(second, BOB_ID, 'doubt');
    await harness.settle(second, 'claim_lost');
    const third = await harness.createCall(2);
    harness.preparePoints(third, 'group_two_win');
    await harness.tap(third, ALICE_ID, 'back');
    await harness.tap(third, CARA_ID, 'doubt');
    await harness.settle(third, 'claim_won');
    await harness.command('leaderboard', GROUP_ONE_ID, ALICE_ID);
    await harness.command('mystats', GROUP_ONE_ID, ALICE_ID);
    await harness.command('mystats', GROUP_TWO_ID, ALICE_ID);

    // Then loss/streak projections and every Telegram destination remain group-scoped
    await expect(harness.runtime.db.groupPlayerStats(GROUP_ONE_ID, ALICE_ID)).resolves.toEqual({
      group_id: GROUP_ONE_ID, user_id: ALICE_ID, points: 10, wins: 1, losses: 1,
      accuracy: 0.5, current_streak: 0, best_streak: 1,
    });
    await expect(harness.runtime.db.groupPlayerStats(GROUP_TWO_ID, ALICE_ID)).resolves.toEqual({
      group_id: GROUP_TWO_ID, user_id: ALICE_ID, points: 10, wins: 1, losses: 0,
      accuracy: 1, current_streak: 1, best_streak: 1,
    });
    for (const market of [first, second, third]) {
      const results = await harness.runtime.db.pointResultsForMarket(market.id);
      expect(results).toHaveLength(2);
      expect(results.some((result) => result.user_id === CALLER_ID)).toBe(false);
      expect(new Set(results.map((result) => `${result.market_id}:${result.user_id}`)).size).toBe(2);
    }
    expect([first, second, third].map((market) => harness.runtime.db.applyCount(market.id))).toEqual([2, 1, 1]);
    for (const [market, groupId] of [[first, GROUP_ONE_ID], [second, GROUP_ONE_ID], [third, GROUP_TWO_ID]] as const) {
      const receiptId = encodeReceiptId(market.id) ?? market.id;
      const messages = harness.runtime.transport.calls.filter((call) => call.text?.includes(receiptId));
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((call) => call.chatId === groupId)).toBe(true);
    }
    const commandTexts = harness.runtime.transport.outboundTexts().filter((text) =>
      text.startsWith('Group leaderboard') || text.startsWith('Your group stats'),
    );
    expect(commandTexts).toEqual([
      'Group leaderboard\n1st. @alice_calls - 10 points, 1 win, 1 loss, 50% accuracy\n2nd. Bob - 10 points, 1 win, 1 loss, 50% accuracy',
      'Your group stats\nRank: 1st\nPoints: 10\nWins: 1\nLosses: 1\nAccuracy: 50%\nCurrent streak: 0\nBest streak: 1',
      'Your group stats\nRank: 1st\nPoints: 10\nWins: 1\nLosses: 0\nAccuracy: 100%\nCurrent streak: 1\nBest streak: 1',
    ]);

    // Then the exact outbound channel order is deterministic and every text is bounded and redacted
    expect(harness.outboundSequence()).toEqual([
      { method: 'sendMessage', chatId: GROUP_ONE_ID, kind: 'call' },
      { method: 'editMessageText', chatId: GROUP_ONE_ID, kind: 'card-open' },
      { method: 'answerCallbackQuery', chatId: null, kind: 'choice-toast' },
      { method: 'editMessageText', chatId: GROUP_ONE_ID, kind: 'card-open' },
      { method: 'answerCallbackQuery', chatId: null, kind: 'choice-toast' },
      { method: 'editMessageText', chatId: GROUP_ONE_ID, kind: 'card-open' },
      { method: 'editMessageText', chatId: GROUP_ONE_ID, kind: 'card-locked' },
      { method: 'editMessageReplyMarkup', chatId: GROUP_ONE_ID, kind: 'metadata' },
      { method: 'editMessageText', chatId: GROUP_ONE_ID, kind: 'card-settled' },
      { method: 'sendMessage', chatId: GROUP_ONE_ID, kind: 'receipt' },
      { method: 'sendMessage', chatId: GROUP_ONE_ID, kind: 'call' },
      { method: 'editMessageText', chatId: GROUP_ONE_ID, kind: 'card-open' },
      { method: 'answerCallbackQuery', chatId: null, kind: 'choice-toast' },
      { method: 'editMessageText', chatId: GROUP_ONE_ID, kind: 'card-open' },
      { method: 'answerCallbackQuery', chatId: null, kind: 'choice-toast' },
      { method: 'editMessageText', chatId: GROUP_ONE_ID, kind: 'card-open' },
      { method: 'editMessageText', chatId: GROUP_ONE_ID, kind: 'card-locked' },
      { method: 'editMessageReplyMarkup', chatId: GROUP_ONE_ID, kind: 'metadata' },
      { method: 'editMessageText', chatId: GROUP_ONE_ID, kind: 'card-settled' },
      { method: 'sendMessage', chatId: GROUP_ONE_ID, kind: 'receipt' },
      { method: 'sendMessage', chatId: GROUP_TWO_ID, kind: 'call' },
      { method: 'editMessageText', chatId: GROUP_TWO_ID, kind: 'card-open' },
      { method: 'answerCallbackQuery', chatId: null, kind: 'choice-toast' },
      { method: 'editMessageText', chatId: GROUP_TWO_ID, kind: 'card-open' },
      { method: 'answerCallbackQuery', chatId: null, kind: 'choice-toast' },
      { method: 'editMessageText', chatId: GROUP_TWO_ID, kind: 'card-open' },
      { method: 'editMessageText', chatId: GROUP_TWO_ID, kind: 'card-locked' },
      { method: 'editMessageReplyMarkup', chatId: GROUP_TWO_ID, kind: 'metadata' },
      { method: 'editMessageText', chatId: GROUP_TWO_ID, kind: 'card-settled' },
      { method: 'sendMessage', chatId: GROUP_TWO_ID, kind: 'receipt' },
      { method: 'sendMessage', chatId: GROUP_ONE_ID, kind: 'leaderboard' },
      { method: 'sendMessage', chatId: GROUP_ONE_ID, kind: 'mystats' },
      { method: 'sendMessage', chatId: GROUP_TWO_ID, kind: 'mystats' },
    ]);
    const outbound = harness.runtime.transport.outboundTexts();
    const joined = outbound.join('\n');
    const logs = JSON.stringify(harness.runtime.log.events);
    const wallet = await harness.runtime.wager.walletSummary();
    expect(harness.runtime.deps.env.TELEGRAM_BOT_TOKEN).toBe(RUNTIME_TELEGRAM_TOKEN_SENTINEL);
    expect(wallet.pubkey).toBe(WALLET_ADDRESS_SENTINEL);
    const credentials = [
      TEST_BOT_TOKEN,
      harness.runtime.deps.env.TELEGRAM_BOT_TOKEN,
      harness.runtime.deps.env.GLM_API_KEY,
      harness.runtime.deps.env.SUPABASE_SERVICE_ROLE_KEY,
      harness.runtime.deps.env.TXLINE_GUEST_JWT,
      harness.runtime.deps.env.TXLINE_API_TOKEN,
      harness.runtime.deps.env.ENGINE_CONCIERGE_TOKEN,
      harness.runtime.deps.env.ENGINE_TELEGRAM_TOKEN,
      harness.runtime.deps.env.ENGINE_OPS_TOKEN,
      WALLET_ADDRESS_SENTINEL,
    ];
    const forbidden = [
      CALLER_ID, ALICE_ID, BOB_ID, CARA_ID, GROUP_ONE_ID, GROUP_TWO_ID,
    ].map(String).concat(credentials);
    expect(outbound.every((text) => text.length <= 4_096)).toBe(true);
    expect(forbidden.some((secret) => joined.includes(secret))).toBe(false);
    expect(credentials.some((secret) => logs.includes(secret))).toBe(false);
    expect(joined).not.toMatch(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
  });

  it('preserves group-two card isolation for overlapping users', async () => {
    // Given one populated card in each group with Alice overlapping
    const harness = new TelegramPointsFlowHarness();
    const groupOne = await harness.createCall(0);
    await harness.tap(groupOne, ALICE_ID, 'back');
    await harness.tap(groupOne, BOB_ID, 'doubt');
    const groupTwo = await harness.createCall(2);
    await harness.tap(groupTwo, ALICE_ID, 'back');
    await harness.tap(groupTwo, CARA_ID, 'doubt');

    // When each latest public card is read from the real Telegram edit stream
    const groupOneCard = requiredCall(
      harness.runtime.transport.calls,
      (call) => call.chatId === GROUP_ONE_ID
        && call.text?.includes(encodeReceiptId(groupOne.id) ?? groupOne.id) === true
        && call.text.includes('Draw or loss · 0.01 SOL · Bob'),
      'group-one populated card',
    );
    const groupTwoCard = requiredCall(
      harness.runtime.transport.calls,
      (call) => call.chatId === GROUP_TWO_ID
        && call.text?.includes(encodeReceiptId(groupTwo.id) ?? groupTwo.id) === true
        && call.text.includes('Draw or loss · 0.01 SOL · @cara_calls'),
      'group-two populated card',
    );

    // Then intended labels stay in their origin group and cross-group names are absent
    expect(groupOneCard.text).toContain('Atlas FC to win · 0.01 SOL · @alice_calls');
    expect(groupOneCard.text).toContain('Draw or loss · 0.01 SOL · Bob');
    expect(groupOneCard.text).not.toContain('@cara_calls');
    expect(groupTwoCard.text).toContain('Cygnus FC to win · 0.01 SOL · @alice_calls');
    expect(groupTwoCard.text).toContain('Draw or loss · 0.01 SOL · @cara_calls');
    expect(groupTwoCard.text).not.toMatch(/It (?:happens|does not):[^\n]*Bob/);
  });
});
