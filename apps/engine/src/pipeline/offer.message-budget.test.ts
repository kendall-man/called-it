import type { RawClaimParse } from '@calledit/market-engine';
import { describe, expect, it } from 'vitest';
import type { HandlerCtx } from '../bot/context.js';
import { renderFallback, type Say } from '../bot/copy.js';
import {
  CALLER_ID,
  CALL_FIXTURES,
  fixtureRows,
  GROUPS,
} from '../points/telegram-points-flow-fixtures.test-support.js';
import { createTelegramFlowRuntime } from '../points/telegram-points-flow-runtime.test-support.js';
import { telegramUser } from '../points/telegram-points-flow-telegram.test-support.js';
import type { Deps } from '../ports.js';
import { registerEscrowMarketProvisioner } from './escrow-market-provisioning.js';
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
    // The full card arrives as an EDIT of the skeleton card message.
    const sent = runtime.transport.calls.find(
      (call) => call.method === 'editMessageText' && call.text?.includes('🎙 THE CALL'),
    );
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

  it('does not mint a live market when a replay ends during pricing', async () => {
    const runtime = createTelegramFlowRuntime();
    const fixture = fixtureRows()[0];
    const callFixture = CALL_FIXTURES[0];
    const group = GROUPS.find((candidate) => candidate.id === callFixture.groupId);
    if (fixture === undefined || group === undefined) throw new TypeError('Replay race fixture is missing');
    const raw: RawClaimParse = {
      claimType: 'match_winner', fixtureId: fixture.fixture_id,
      entityName: fixture.p1_name, entityKind: 'team', comparator: 'gte',
      threshold: 1, period: 'FT_90', unresolved: null,
    };
    let resolveQuote: ((value: Awaited<ReturnType<typeof runtime.deps.tx.fetchOdds>>) => void) | undefined;
    let markQuoteStarted = (): void => undefined;
    const quoteStarted = new Promise<void>((resolve) => { markQuoteStarted = resolve; });
    runtime.deps.tx.fetchOdds = async () => {
      markQuoteStarted();
      return new Promise((resolve) => { resolveQuote = resolve; });
    };
    runtime.deps.agent.parse = async () => raw;
    await runtime.h.supervisor.startReplay(group.id, fixture);

    const offering = offerClaim(runtime.h, {
      chatId: group.id,
      group,
      text: `${fixture.p1_name} will beat ${fixture.p2_name}`,
      claimer: telegramUser(CALLER_ID, 'Dee Caller', 'dee_calls'),
      sourceMessageId: 701,
      confidence: 1,
      announce: true,
      consent: 'explicit',
    });
    await quoteStarted;
    runtime.h.supervisor.stopReplay(group.id);
    resolveQuote?.({
      kind: 'ok',
      odds: {
        p1x2: { home: 0.6, draw: 0.25, away: 0.15 },
        totals: { line: 2.5, overProb: 0.55 },
        oddsMessageId: 'replay-odds',
        oddsTsMs: Date.parse(fixture.kickoff_at!) - 60_000,
      },
    });
    await offering;

    expect(runtime.db.marketList()).toEqual([]);
  });

  it('keeps the replay group lock until escrow provisioning is ready', async () => {
    const runtime = createTelegramFlowRuntime();
    const fixture = fixtureRows()[0];
    const callFixture = CALL_FIXTURES[0];
    const group = GROUPS.find((candidate) => candidate.id === callFixture.groupId);
    if (fixture === undefined || group === undefined) throw new TypeError('Replay lock fixture is missing');
    const raw: RawClaimParse = {
      claimType: 'match_winner', fixtureId: fixture.fixture_id,
      entityName: fixture.p1_name, entityKind: 'team', comparator: 'gte',
      threshold: 1, period: 'FT_90', unresolved: null,
    };
    runtime.deps.agent.parse = async () => raw;
    await runtime.h.supervisor.startReplay(group.id, fixture);

    const escrowDeps = {
      ...runtime.deps,
      env: { ...runtime.deps.env, WAGER_CUSTODY_MODE: 'escrow' },
    } as Deps;
    let lockHeld = false;
    let provisionedWhileLocked = false;
    let markProvisioningStarted = (): void => undefined;
    let releaseProvisioning = (): void => undefined;
    const provisioningStarted = new Promise<void>((resolve) => { markProvisioningStarted = resolve; });
    const provisioningGate = new Promise<void>((resolve) => { releaseProvisioning = resolve; });
    const runExclusive = runtime.h.supervisor.runGroupExclusive.bind(runtime.h.supervisor);
    runtime.h.supervisor.runGroupExclusive = async (groupId, task) => runExclusive(groupId, async () => {
      lockHeld = true;
      try {
        return await task();
      } finally {
        lockHeld = false;
      }
    });
    registerEscrowMarketProvisioner(escrowDeps, {
      async ensure() {
        provisionedWhileLocked = lockHeld;
        markProvisioningStarted();
        await provisioningGate;
        return true;
      },
    });

    const offering = offerClaim({ ...runtime.h, deps: escrowDeps }, {
      chatId: group.id,
      group,
      text: `${fixture.p1_name} will beat ${fixture.p2_name}`,
      claimer: telegramUser(CALLER_ID, 'Dee Caller', 'dee_calls'),
      sourceMessageId: 702,
      confidence: 1,
      announce: true,
      consent: 'explicit',
    });
    await provisioningStarted;
    let nextReplayEventRan = false;
    const nextReplayEvent = runtime.h.supervisor.runGroupExclusive(group.id, async () => {
      nextReplayEventRan = true;
    });
    await Promise.resolve();

    expect(provisionedWhileLocked).toBe(true);
    expect(nextReplayEventRan).toBe(false);
    releaseProvisioning();
    await Promise.all([offering, nextReplayEvent]);
    expect(nextReplayEventRan).toBe(true);
  });
});
