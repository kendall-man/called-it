/**
 * Single-message claim lifecycle (STAKE_LADDER_ENABLED): one evolving Telegram
 * message carries a claim from the consent gate / reading shell through
 * clarify, pricing skeleton, offer card, and settled board. Every pre-mint
 * state EDITS the one surface, and the market card INHERITS its id, so no new
 * card message is ever posted. Flag-off parity is asserted by the sibling
 * offer.skeleton suite (which runs with the flag off, unchanged).
 */

import { describe, expect, it, vi } from 'vitest';
import type { CompileResult, MarketSpec } from '@calledit/market-engine';
import type { Context } from 'grammy';
import type { HandlerCtx } from '../bot/context.js';
import type { ClaimRow, GroupRow } from '../ports.js';
import { CLAIM_DECLINED_LINE } from '../bot/cards.js';
import {
  CALLER_ID,
  CALL_FIXTURES,
  GROUPS,
} from '../points/telegram-points-flow-fixtures.test-support.js';
import {
  createTelegramFlowRuntime,
  type TelegramFlowRuntime,
} from '../points/telegram-points-flow-runtime.test-support.js';
import {
  callbackContext,
  telegramUser,
} from '../points/telegram-points-flow-telegram.test-support.js';
import { ClaimSurfaceStore } from './claim-surface.js';
import { offerClaim } from './offer.js';
import { dispatchCallback } from '../bot/callbacks.js';

const SOURCE_MESSAGE_ID = 700;

interface LadderSetup {
  readonly runtime: TelegramFlowRuntime;
  readonly h: HandlerCtx;
  readonly claimSurface: ClaimSurfaceStore;
  readonly group: GroupRow;
  readonly text: string;
  readonly claimer: ReturnType<typeof telegramUser>;
  /** The first claim the runtime inserted this test (captured off insertClaim). */
  readonly firstClaim: () => Promise<ClaimRow>;
}

/** A flag-on (STAKE_LADDER_ENABLED) runtime with a live surface store. */
function ladderSetup(): LadderSetup {
  const runtime = createTelegramFlowRuntime();
  Object.assign(runtime.deps.env, { STAKE_LADDER_ENABLED: true });
  const claimSurface = new ClaimSurfaceStore();
  const h: HandlerCtx = { ...runtime.h, claimSurface };
  const fixture = CALL_FIXTURES[0];
  const group = GROUPS.find((candidate) => candidate.id === fixture.groupId);
  if (group === undefined) throw new TypeError('Lifecycle test group is missing');
  const insertSpy = vi.spyOn(runtime.db, 'insertClaim');
  return {
    runtime,
    h,
    claimSurface,
    group,
    text: fixture.text,
    claimer: telegramUser(CALLER_ID, 'Dee Caller', 'dee_calls'),
    firstClaim: async () => {
      const result = insertSpy.mock.results[0];
      if (result === undefined || result.type !== 'return') throw new TypeError('No claim inserted');
      return (await result.value) as ClaimRow;
    },
  };
}

function cardSends(runtime: TelegramFlowRuntime): readonly string[] {
  return runtime.transport.calls
    .filter((call) => call.method === 'sendMessage' && (call.text?.includes('🎙 THE CALL') ?? false))
    .flatMap((call) => (call.text === null ? [] : [call.text]));
}

function confirmCtx(setup: LadderSetup, messageId: number, callbackId = 'cb-1'): Context {
  return callbackContext({
    bot: setup.runtime.bot,
    updateId: 1,
    callbackId,
    groupId: setup.group.id,
    groupTitle: setup.group.title,
    messageId,
    user: setup.claimer,
  });
}

async function postPassiveGate(setup: LadderSetup): Promise<{ claim: ClaimRow; gateId: number }> {
  await offerClaim(setup.h, {
    chatId: setup.group.id,
    group: setup.group,
    text: setup.text,
    claimer: setup.claimer,
    sourceMessageId: SOURCE_MESSAGE_ID,
    confidence: 0.9,
    announce: false,
    consent: 'awaiting_confirm',
  });
  await setup.runtime.queue.idle();
  const claim = await setup.firstClaim();
  const gate = setup.runtime.transport.calls.find(
    (call) => call.method === 'sendMessage' && (call.text?.includes('confirm this is your call') ?? false),
  );
  if (gate === undefined) throw new TypeError('Consent gate was not posted');
  return { claim, gateId: gate.messageId };
}

describe('single-message claim lifecycle (STAKE_LADDER_ENABLED)', () => {
  it('posts the consent gate exactly once and persists it as the surface id', async () => {
    const setup = ladderSetup();
    const { claim, gateId } = await postPassiveGate(setup);

    const sends = setup.runtime.transport.calls.filter((call) => call.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(setup.claimSurface.get(claim.id)).toBe(gateId);
    // Nothing public before confirm: no card message yet.
    expect(cardSends(setup.runtime)).toHaveLength(0);
  });

  it('edits the SAME gate message through confirm → mint, inheriting the surface id', async () => {
    const setup = ladderSetup();
    const { claim, gateId } = await postPassiveGate(setup);

    await dispatchCallback(setup.h, confirmCtx(setup, gateId), { t: 'confirm', claimId: claim.id });
    await setup.runtime.queue.idle();

    const market = setup.runtime.db.marketList().find((m) => m.group_id === setup.group.id);
    if (market === undefined) throw new TypeError('Confirm did not mint a market');
    // The market card INHERITS the gate's message id: one message, start to card.
    expect(market.card_tg_message_id).toBe(gateId);
    // The offer card arrives as an EDIT of the gate; never a fresh card post.
    expect(cardSends(setup.runtime)).toHaveLength(0);
    const fullCard = setup.runtime.transport.calls.find(
      (call) => call.method === 'editMessageText' && (call.text?.includes('Feed says') ?? false),
    );
    expect(fullCard?.messageId).toBe(gateId);
  });

  it('does not post a duplicate surface when confirm is retried', async () => {
    const setup = ladderSetup();
    const { claim, gateId } = await postPassiveGate(setup);

    await dispatchCallback(setup.h, confirmCtx(setup, gateId, 'cb-a'), { t: 'confirm', claimId: claim.id });
    await setup.runtime.queue.idle();
    await dispatchCallback(setup.h, confirmCtx(setup, gateId, 'cb-b'), { t: 'confirm', claimId: claim.id });
    await setup.runtime.queue.idle();

    expect(setup.runtime.db.marketList()).toHaveLength(1);
    // Still no fresh card message: the retry is stale, the surface stays one.
    expect(cardSends(setup.runtime)).toHaveLength(0);
  });

  it('turns the SAME surface into clarify options, then the offer card on the pick', async () => {
    const setup = ladderSetup();
    const optionA: MarketSpec = { ...BASE_SPEC, period: 'FT_90' };
    const optionB: MarketSpec = { ...BASE_SPEC, period: 'FT' };
    setup.runtime.deps.engine.compileClaim = (): CompileResult => ({
      kind: 'clarify',
      question: 'in 90 minutes, or advancing?',
      options: [
        { label: '90 minutes', spec: optionA },
        { label: 'Advancing', spec: optionB },
      ],
    });
    const { claim, gateId } = await postPassiveGate(setup);

    await dispatchCallback(setup.h, confirmCtx(setup, gateId), { t: 'confirm', claimId: claim.id });
    await setup.runtime.queue.idle();

    // The clarify options REPLACE the gate in place, not as a new message.
    const optionsEdit = setup.runtime.transport.calls.find(
      (call) => call.method === 'editMessageText' && (call.text?.includes('One thing before we lock it in') ?? false),
    );
    expect(optionsEdit?.messageId).toBe(gateId);
    expect(
      setup.runtime.transport.calls.some(
        (call) => call.method === 'sendMessage' && (call.text?.includes('One thing before we lock it in') ?? false),
      ),
    ).toBe(false);

    await dispatchCallback(setup.h, confirmCtx(setup, gateId, 'cb-opt'), { t: 'option', claimId: claim.id, key: '0' });
    await setup.runtime.queue.idle();

    const market = setup.runtime.db.marketList().find((m) => m.group_id === setup.group.id);
    expect(market?.card_tg_message_id).toBe(gateId);
    expect(cardSends(setup.runtime)).toHaveLength(0);
  });

  it('opens an explicit call with a reading shell that the market card inherits', async () => {
    const setup = ladderSetup();
    await offerClaim(setup.h, {
      chatId: setup.group.id,
      group: setup.group,
      text: setup.text,
      claimer: setup.claimer,
      sourceMessageId: SOURCE_MESSAGE_ID,
      confidence: 1,
      announce: true,
      consent: 'explicit',
    });
    await setup.runtime.queue.idle();

    const shell = setup.runtime.transport.calls.find(
      (call) => call.method === 'sendMessage' && (call.text?.includes('Reading the call') ?? false),
    );
    if (shell === undefined) throw new TypeError('Reading shell was not posted');
    const market = setup.runtime.db.marketList()[0];
    expect(market?.card_tg_message_id).toBe(shell.messageId);
    // The full card is an EDIT of the shell; it never posts as a new message.
    expect(
      setup.runtime.transport.calls.some(
        (call) => call.method === 'sendMessage' && (call.text?.includes('Feed says') ?? false),
      ),
    ).toBe(false);
    const fullCard = setup.runtime.transport.calls.find(
      (call) => call.method === 'editMessageText' && (call.text?.includes('Feed says') ?? false),
    );
    expect(fullCard?.messageId).toBe(shell.messageId);
  });

  it('collapses the surface to a one-line close on decline', async () => {
    const setup = ladderSetup();
    const { claim, gateId } = await postPassiveGate(setup);

    await dispatchCallback(setup.h, confirmCtx(setup, gateId), { t: 'decline', claimId: claim.id });
    await setup.runtime.queue.idle();

    const closeEdit = setup.runtime.transport.calls.find(
      (call) => call.method === 'editMessageText' && call.text === CLAIM_DECLINED_LINE,
    );
    expect(closeEdit?.messageId).toBe(gateId);
    expect((await setup.runtime.db.getClaim(claim.id))?.status).toBe('declined');
    expect(setup.claimSurface.get(claim.id)).toBeUndefined();
  });
});

const BASE_SPEC: MarketSpec = {
  claimType: 'match_winner',
  fixtureId: CALL_FIXTURES[0].fixtureId,
  entityRef: { kind: 'team', participant: 1, name: CALL_FIXTURES[0].team },
  comparator: 'gte',
  threshold: 1,
  period: 'FT_90',
  trustTier: 'oracle_resolved',
};
