import { describe, expect, it, vi } from 'vitest';
import type { RawClaimParse } from '@calledit/market-engine';
import type { User } from 'grammy/types';
import type { HandlerCtx } from '../bot/context.js';
import {
  CALLER_ID,
  CALL_FIXTURES,
  GROUPS,
} from '../points/telegram-points-flow-fixtures.test-support.js';
import {
  createTelegramFlowRuntime,
  type TelegramFlowRuntime,
} from '../points/telegram-points-flow-runtime.test-support.js';
import { telegramUser } from '../points/telegram-points-flow-telegram.test-support.js';
import type { Deps, GroupRow, MarketRow } from '../ports.js';
import { registerEscrowMarketProvisioner } from './escrow-market-provisioning.js';
import type { ParseEnvelope } from './claims.js';
import { mintOffer, offerClaim } from './offer.js';

const SOURCE_MESSAGE_ID = 700;
const SKELETON_STATUS = 'Pricing this call off the live feed';

function offerSetup(): {
  runtime: TelegramFlowRuntime;
  group: GroupRow;
  text: string;
  claimer: User;
} {
  const runtime = createTelegramFlowRuntime();
  const fixture = CALL_FIXTURES[0];
  const group = GROUPS.find((candidate) => candidate.id === fixture.groupId);
  if (group === undefined) throw new TypeError('Skeleton test group is missing');
  return {
    runtime,
    group,
    text: fixture.text,
    claimer: telegramUser(CALLER_ID, 'Dee Caller', 'dee_calls'),
  };
}

async function bookExplicitCall(h: HandlerCtx, group: GroupRow, text: string, claimer: User) {
  await offerClaim(h, {
    chatId: group.id,
    group,
    text,
    claimer,
    sourceMessageId: SOURCE_MESSAGE_ID,
    confidence: 1,
    announce: true,
    consent: 'explicit',
  });
}

function mintedMarket(runtime: TelegramFlowRuntime, groupId: number): MarketRow {
  const market = runtime.db.marketList().find((candidate) => candidate.group_id === groupId);
  if (market === undefined) throw new TypeError('Skeleton test did not mint a market');
  return market;
}

describe('offer skeleton card', () => {
  it('posts the skeleton reply then edits the same message into the full offer card', async () => {
    const { runtime, group, text, claimer } = offerSetup();

    await bookExplicitCall(runtime.h, group, text, claimer);
    await runtime.queue.idle();

    const calls = runtime.transport.calls;
    const skeleton = calls.find(
      (call) => call.method === 'sendMessage' && call.text?.includes(SKELETON_STATUS),
    );
    const fullCard = calls.find(
      (call) => call.method === 'editMessageText'
        && call.text?.includes('📈')
        && call.text.includes('Calls open'),
    );
    if (skeleton === undefined || fullCard === undefined) {
      throw new TypeError(`Missing skeleton or edit: ${calls.map((c) => c.method).join(',')}`);
    }
    // The skeleton is the only card send; the full state arrives as an edit of it.
    expect(fullCard.messageId).toBe(skeleton.messageId);
    expect(calls.indexOf(skeleton)).toBeLessThan(calls.indexOf(fullCard));
    expect(fullCard.text).toContain('🎙 THE CALL');
    expect(
      calls.filter((call) => call.method === 'sendMessage' && call.text?.includes('🎙 THE CALL')),
    ).toEqual([skeleton]);
    expect(mintedMarket(runtime, group.id).card_tg_message_id).toBe(skeleton.messageId);
  });

  it('acks the claim with 👀 and shows typing while parse and mint run', async () => {
    const { runtime, group, text, claimer } = offerSetup();

    await bookExplicitCall(runtime.h, group, text, claimer);
    await runtime.queue.idle();

    const reaction = runtime.transport.calls.find((call) => call.method === 'setMessageReaction');
    expect(reaction).toMatchObject({ chatId: group.id, messageId: SOURCE_MESSAGE_ID });
    expect(
      runtime.transport.calls.some((call) => call.method === 'sendChatAction'),
    ).toBe(true);
  });

  it('edits the same skeleton into the paused card when escrow provisioning fails', async () => {
    const { runtime, group, text, claimer } = offerSetup();
    const escrowDeps = {
      ...runtime.deps,
      env: { ...runtime.deps.env, WAGER_CUSTODY_MODE: 'escrow' },
    } as Deps;
    registerEscrowMarketProvisioner(escrowDeps, { async ensure() { return false; } });

    await bookExplicitCall({ ...runtime.h, deps: escrowDeps }, group, text, claimer);
    await runtime.queue.idle();

    const calls = runtime.transport.calls;
    const skeleton = calls.find(
      (call) => call.method === 'sendMessage' && call.text?.includes(SKELETON_STATUS),
    );
    const pausedEdit = calls.find(
      (call) => call.method === 'editMessageText' && call.text?.includes('temporarily paused'),
    );
    if (skeleton === undefined || pausedEdit === undefined) {
      throw new TypeError(`Missing skeleton or paused edit: ${calls.map((c) => c.method).join(',')}`);
    }
    expect(pausedEdit.messageId).toBe(skeleton.messageId);
    // The failure state must not arrive as a separate message.
    expect(
      calls.filter((call) => call.method === 'sendMessage' && call.text?.includes('🎙 THE CALL')),
    ).toEqual([skeleton]);
  });

  it('does not post a second card on a mint retry — it finishes the persisted card instead', async () => {
    const { runtime, group, text, claimer } = offerSetup();
    await bookExplicitCall(runtime.h, group, text, claimer);
    await runtime.queue.idle();
    const market = mintedMarket(runtime, group.id);
    const claim = await runtime.db.getClaim(market.claim_id);
    if (claim === null) throw new TypeError('Skeleton retry claim is missing');
    const cardSendsBefore = runtime.transport.calls.filter(
      (call) => call.method === 'sendMessage' && call.text?.includes('🎙 THE CALL'),
    ).length;
    const envelope: ParseEnvelope = {
      raw: null,
      kind: 'ok',
      options: [{ key: 'ok', label: 'As stated', spec: market.spec }],
    };

    const retried = await mintOffer(runtime.h, claim, group, envelope, 'ok');
    await runtime.queue.idle();

    expect(retried.minted).toBe(false);
    const cardSendsAfter = runtime.transport.calls.filter(
      (call) => call.method === 'sendMessage' && call.text?.includes('🎙 THE CALL'),
    ).length;
    expect(cardSendsAfter).toBe(cardSendsBefore);
    // The retry re-edits the persisted card, healing a crash that stopped
    // between the skeleton post and the full-card edit.
    const repairEdit = runtime.transport.calls
      .filter((call) => call.method === 'editMessageText')
      .at(-1);
    expect(repairEdit).toMatchObject({ messageId: market.card_tg_message_id });
  });

  it('falls back to a fresh full-card post when the skeleton send fails', async () => {
    const { runtime, group, text, claimer } = offerSetup();
    const api = runtime.bot.api;
    const original = api.sendMessage.bind(api);
    vi.spyOn(api, 'sendMessage').mockImplementation(async (chatId, messageText, other) => {
      if (messageText.includes(SKELETON_STATUS)) throw new Error('skeleton send failed');
      return original(chatId, messageText, other);
    });
    const parse: RawClaimParse = {
      claimType: 'match_winner',
      fixtureId: CALL_FIXTURES[0].fixtureId,
      entityName: CALL_FIXTURES[0].team,
      entityKind: 'team',
      comparator: 'gte',
      threshold: 1,
      period: 'FT_90',
      unresolved: null,
    };
    runtime.deps.agent.parse = async () => parse;

    await bookExplicitCall(runtime.h, group, text, claimer);
    await runtime.queue.idle();

    const calls = runtime.transport.calls;
    const fullCard = calls.find(
      (call) => call.method === 'sendMessage'
        && call.text?.includes('📈')
        && call.text.includes('Calls open'),
    );
    if (fullCard === undefined) {
      throw new TypeError(`Fallback full card missing: ${calls.map((c) => c.method).join(',')}`);
    }
    expect(
      calls.some((call) => call.method === 'editMessageText'
        && call.text?.includes('📈')
        && call.text.includes('Calls open')),
    ).toBe(false);
    expect(mintedMarket(runtime, group.id).card_tg_message_id).toBe(fullCard.messageId);
  });
});
