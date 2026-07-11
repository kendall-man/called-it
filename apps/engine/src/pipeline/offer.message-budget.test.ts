import type { RawClaimParse } from '@calledit/market-engine';
import { describe, expect, it } from 'vitest';
import type { HandlerCtx } from '../bot/context.js';
import { renderFallback, type Say } from '../bot/copy.js';
import {
  CALLER_ID,
  CALL_FIXTURES,
  GROUPS,
} from '../points/telegram-points-flow-fixtures.test-support.js';
import { createTelegramFlowRuntime } from '../points/telegram-points-flow-runtime.test-support.js';
import { telegramUser } from '../points/telegram-points-flow-telegram.test-support.js';
import { offerClaim } from './offer.js';

const LONG_QUOTE = Array.from({ length: 2_000 }, (_, index) =>
  `line ${index + 1} ${'🏆'.repeat(3)}`).join('\n');

describe('offer Telegram message budget', () => {
  it('preserves the complete card and records onSent after truncating huge garnish', async () => {
    const runtime = createTelegramFlowRuntime();
    const fixture = CALL_FIXTURES[0];
    const group = GROUPS.find((candidate) => candidate.id === fixture.groupId);
    if (group === undefined) throw new TypeError('Offer test group is missing');
    const raw: RawClaimParse = {
      claimType: 'match_winner', fixtureId: fixture.fixtureId,
      entityName: fixture.team, entityKind: 'team', comparator: 'gte',
      threshold: 1, period: 'FT_90', unresolved: null,
    };
    const say: Say = async (key, vars = {}) => key === 'offer_live'
      ? `Garnish ${'🏆'.repeat(3_000)}`
      : renderFallback(key, vars);
    const h: HandlerCtx = {
      ...runtime.h,
      deps: {
        ...runtime.deps,
        agent: { ...runtime.deps.agent, parse: async () => raw },
      },
      say,
    };

    await offerClaim(h, {
      chatId: group.id, group, text: LONG_QUOTE,
      claimer: telegramUser(CALLER_ID, 'Dee Caller', 'dee_calls'),
      sourceMessageId: 700, confidence: 1, announce: true, consent: 'explicit',
    });
    await runtime.queue.idle();

    const market = runtime.db.marketList().find((candidate) => candidate.group_id === group.id);
    const sent = runtime.transport.calls.find((call) => call.text?.includes('🎙 THE CALL'));
    if (market === undefined || sent?.text === null || sent === undefined) {
      const events = runtime.log.events.map((entry) => entry.event).join(',');
      const calls = runtime.transport.calls.map((call) => `${call.method}:${call.text?.slice(0, 20)}`).join(',');
      throw new TypeError(`Offer test did not post a market card; markets=${runtime.db.marketList().length}; events=${events}; calls=${calls}`);
    }
    const mandatoryLines = [
      '⚡ Backing it: 0 SOL (0 in)',
      '🛑 Against it: 0 SOL (0 in)',
      '🤝 Matched: 0%',
      'It happens: No one yet',
      'It does not: No one yet',
      'Choices and results are visible in this group.',
      `Receipt: https://calledit.invalid/r/${market.id}`,
      'Test SOL has no monetary value.',
    ];
    expect(sent.text.length).toBeLessThanOrEqual(4_096);
    for (const line of mandatoryLines) expect(sent.text).toContain(line);
    expect(sent.text).not.toMatch(/\nline 2 /);
    expect(sent.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(market.card_tg_message_id).toBe(sent.messageId);
  });
});
