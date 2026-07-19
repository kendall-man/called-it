import {
  TUNABLES,
  type MatchEvent,
  type PositionSide,
  type SettlementOutcome,
} from '@calledit/market-engine';
import type { MarketRow, UserRow } from '../ports.js';
import { ensureChatContext } from '../bot/context.js';
import { dispatchCallback } from '../bot/callbacks.js';
import { offerClaim } from '../pipeline/offer.js';
import { sweepUnpostedSettlements } from '../cron/index.js';
import { createTelegramFlowRuntime, type TelegramFlowRuntime } from './telegram-points-flow-runtime.test-support.js';
import { callbackContext, commandUpdate, telegramUser } from './telegram-points-flow-telegram.test-support.js';
import {
  CALLER_ID,
  CALL_FIXTURES,
  NOW_MS,
  USERS,
  pointTransition,
  type PointFixtureKind,
} from './telegram-points-flow-fixtures.test-support.js';

class MissingScenarioState extends Error {
  readonly name = 'MissingScenarioState';
  constructor(readonly state: string) { super(`Missing Telegram flow state: ${state}`); }
}

function score(p1Goals: number, p2Goals: number): MatchEvent['score'] {
  return {
    p1: { goals: p1Goals, yellowCards: 0, redCards: 0, corners: 0 },
    p2: { goals: p2Goals, yellowCards: 0, redCards: 0, corners: 0 },
    p1Goals90: p1Goals,
    p2Goals90: p2Goals,
  };
}

function scenarioUser(userId: number): UserRow {
  const user = USERS.find((candidate) => candidate.id === userId);
  if (user === undefined) throw new MissingScenarioState(`user:${userId}`);
  return user;
}

export type OutboundStep = {
  readonly method: string;
  readonly chatId: number | null;
  readonly kind: string;
};

function outboundKind(method: string, text: string | null): string {
  if (method === 'answerCallbackQuery') return 'choice-toast';
  if (text === null) return 'metadata';
  if (text.includes('🏁 RESULT')) return 'receipt';
  if (text.startsWith('Group leaderboard')) return 'leaderboard';
  if (text.startsWith('Your group stats')) return 'mystats';
  if (text.includes('🎙 THE CALL')) {
    if (method === 'sendMessage') return 'call';
    if (text.includes('🚦 Calls locked')) return 'card-locked';
    return text.includes('🚦 Settled') ? 'card-settled' : 'card-open';
  }
  return text.split('\n')[0] ?? '';
}

export class TelegramPointsFlowHarness {
  readonly runtime: TelegramFlowRuntime = createTelegramFlowRuntime();
  private updateSequence = 1;
  private sourceMessageSequence = 500;
  private readonly sweeperInFlight = new Map<string, number>();

  async createCall(index: 0 | 1 | 2): Promise<MarketRow> {
    const fixture = CALL_FIXTURES[index];
    const caller = scenarioUser(CALLER_ID);
    const actor = telegramUser(caller.id, caller.display_name, caller.username ?? undefined);
    const group = await ensureChatContext(
      this.runtime.h,
      fixture.groupId,
      this.groupTitle(fixture.groupId),
      actor,
    );
    await offerClaim(this.runtime.h, {
      chatId: fixture.groupId,
      group,
      text: fixture.text,
      claimer: actor,
      sourceMessageId: this.sourceMessageSequence++,
      confidence: 1,
      announce: true,
      consent: 'explicit',
    });
    await this.runtime.queue.idle();
    const market = this.runtime.db.marketList().find((row) => row.fixture_id === fixture.fixtureId);
    if (market === undefined) throw new MissingScenarioState(`market:${fixture.fixtureId}`);
    return market;
  }

  preparePoints(market: MarketRow, kind: PointFixtureKind, readOutage = false): void {
    this.runtime.db.setPointTransition(market.id, pointTransition(kind, market.id));
    if (readOutage) this.runtime.db.injectPointReadOutage(market.id);
  }

  async tap(market: MarketRow, userId: number, side: PositionSide): Promise<void> {
    const fresh = await this.requiredMarket(market.id);
    const messageId = fresh.card_tg_message_id;
    if (messageId === null) throw new MissingScenarioState(`card:${market.id}`);
    const user = scenarioUser(userId);
    const ctx = callbackContext({
      bot: this.runtime.bot,
      updateId: this.updateSequence++,
      callbackId: `tap-${this.updateSequence}`,
      groupId: fresh.group_id,
      groupTitle: this.groupTitle(fresh.group_id),
      messageId,
      user: telegramUser(user.id, user.display_name, user.username ?? undefined),
    });
    await dispatchCallback(this.runtime.h, ctx, {
      t: 'stake',
      marketId: fresh.id,
      side,
      presetIndex: 0,
    });
    await this.runtime.queue.idle();
  }

  async settle(
    market: MarketRow,
    outcome: Exclude<SettlementOutcome, 'void'>,
  ): Promise<MatchEvent> {
    const receivedAtMs = NOW_MS + this.updateSequence * 1_000;
    const winningClaim = outcome === 'claim_won';
    const event: MatchEvent = {
      kind: 'phase_change',
      fixtureId: market.fixture_id,
      seq: 1,
      tsMs: receivedAtMs - 100,
      receivedAtMs,
      confirmed: true,
      phase: 'F',
      minute: 90,
      score: winningClaim ? score(1, 0) : score(0, 1),
    };
    await this.runtime.settler.onEvent(event);
    await this.runtime.settler.tick(receivedAtMs + TUNABLES.SETTLEMENT_DEBOUNCE_MS);
    await this.runtime.queue.idle();
    return event;
  }

  async repeatTerminal(event: MatchEvent): Promise<void> {
    await this.runtime.settler.onEvent(event);
    await this.runtime.queue.idle();
  }

  async recoverUnpostedSettlements(): Promise<void> {
    await sweepUnpostedSettlements(
      this.runtime.deps,
      this.runtime.settler,
      this.sweeperInFlight,
    );
    await this.runtime.queue.idle();
  }

  async command(
    command: 'leaderboard' | 'mystats',
    groupId: number,
    userId: number,
  ): Promise<void> {
    const user = scenarioUser(userId);
    await this.runtime.bot.handleUpdate(commandUpdate({
      updateId: this.updateSequence++,
      messageId: this.sourceMessageSequence++,
      groupId,
      groupTitle: this.groupTitle(groupId),
      command,
      user: telegramUser(user.id, user.display_name, user.username ?? undefined),
    }));
    await this.runtime.queue.idle();
  }

  outboundSequence(): readonly OutboundStep[] {
    return this.runtime.transport.calls
      // Presence traffic (reactions, chat actions) is fire-and-forget and
      // bypasses the send queue, so its interleaving with queued sends is
      // not deterministic — the sequence contract covers messages only.
      .filter((call) => call.method !== 'setMessageReaction' && call.method !== 'sendChatAction')
      .map((call) => ({
        method: call.method,
        chatId: call.chatId,
        kind: outboundKind(call.method, call.text),
      }));
  }

  private async requiredMarket(marketId: string): Promise<MarketRow> {
    const market = await this.runtime.db.getMarket(marketId);
    if (market === null) throw new MissingScenarioState(`market:${marketId}`);
    return market;
  }

  private groupTitle(groupId: number): string {
    const group = CALL_FIXTURES.find((fixture) => fixture.groupId === groupId);
    if (group === undefined) throw new MissingScenarioState(`group:${groupId}`);
    return groupId === CALL_FIXTURES[0].groupId ? 'North Stand' : 'Away End';
  }
}
