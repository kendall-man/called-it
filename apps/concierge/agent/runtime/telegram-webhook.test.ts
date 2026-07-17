import { describe, expect, it } from 'vitest';
import { ConciergeLifecycle } from './lifecycle.js';
import {
  TELEGRAM_ALLOWED_UPDATES,
  verifyAndRouteTelegramWebhook,
  type TelegramForwarder,
} from './telegram-forwarding.js';

const WEBHOOK_SECRET = 'telegram-webhook-secret-token-32bytes';

describe('Telegram full-envelope webhook gate', () => {
  it('declares only the Telegram update types the concierge consumes', () => {
    // Given the single-ingress Telegram route
    const allowedUpdates = TELEGRAM_ALLOWED_UPDATES;

    // When the webhook registration contract is read
    const received = allowedUpdates;

    // Then Telegram can deliver no unrelated update families
    expect(received).toEqual(['message', 'callback_query', 'my_chat_member']);
  });

  it.each([
    { name: 'a missing secret header', secret: undefined },
    { name: 'a mismatched secret header', secret: 'incorrect-webhook-secret-token-32bytes' },
  ])('rejects $name before parsing or forwarding', async ({ secret }) => {
    // Given an inbound Telegram message with an untrusted secret header
    const update = groupMessageUpdate(101);
    const forwarded: Record<string, unknown>[] = [];

    // When the Eve webhook verifier examines the full envelope
    const accepted = await verifyAndRouteTelegramWebhook(
      requestFor(update, secret),
      JSON.stringify(update),
      gateOptions(forwarded),
    );

    // Then Eve rejects it before any engine state can be touched
    expect(accepted).toBe(false);
    expect(forwarded).toEqual([]);
  });

  it.each([
    { update_id: -1 },
    { update_id: 1.5 },
    { update_id: '101' },
  ])('rejects an invalid update_id without forwarding', async (update) => {
    // Given a Telegram-shaped envelope that lacks a valid stable update id
    const forwarded: Record<string, unknown>[] = [];
    const body = JSON.stringify({
      ...update,
      message: { chat: { id: -100, type: 'group' }, text: 'Arsenal win' },
    });

    // When the verified envelope is parsed at the trust boundary
    const accepted = await verifyAndRouteTelegramWebhook(
      requestForBody(body),
      body,
      gateOptions(forwarded),
    );

    // Then it is rejected instead of gaining a synthetic identity
    expect(accepted).toBe(false);
    expect(forwarded).toEqual([]);
  });

  it.each([
    { name: 'a group message', update: groupMessageUpdate(201) },
    {
      name: 'an engine callback',
      update: {
        update_id: 202,
        callback_query: {
          id: 'callback-202',
          from: { id: 9, is_bot: false, first_name: 'A' },
          data: 'st:market:back:10000000',
          chat_instance: 'chat-instance',
          message: { message_id: 8, date: 0, chat: { id: -100, type: 'group', title: 'N5' } },
        },
      },
    },
    {
      name: 'a membership service update',
      update: {
        update_id: 203,
        my_chat_member: {
          chat: { id: -100, type: 'group', title: 'N5' },
          from: { id: 9, is_bot: false, first_name: 'A' },
          date: 1,
          old_chat_member: { status: 'left', user: { id: 1, is_bot: true, first_name: 'Callie' } },
          new_chat_member: { status: 'member', user: { id: 1, is_bot: true, first_name: 'Callie' } },
        },
      },
    },
  ])('forwards the durable raw envelope for $name', async ({ update }) => {
    // Given an engine-owned Telegram envelope
    const forwarded: Record<string, unknown>[] = [];
    const body = JSON.stringify(update);

    // When Eve's verified full-envelope gate routes it
    const returnedBody = await verifyAndRouteTelegramWebhook(
      requestForBody(body),
      body,
      gateOptions(forwarded),
    );

    // Then the engine receives the original update and Eve cannot process it too
    expect(forwarded).toEqual([update]);
    expect(returnedBody).toBe(JSON.stringify({ update_id: update.update_id }));
  });

  it('leaves only a safe private conversation for Eve to parse', async () => {
    // Given a private free-text message with no command or reply ownership ambiguity
    const update = {
      update_id: 301,
      message: {
        message_id: 7,
        date: 1,
        chat: { id: 9, type: 'private', first_name: 'Ada' },
        from: { id: 9, is_bot: false, first_name: 'Ada' },
        text: 'What calls are open?',
      },
    };
    const body = JSON.stringify(update);
    const forwarded: Record<string, unknown>[] = [];

    // When the full envelope passes verification
    const returnedBody = await verifyAndRouteTelegramWebhook(
      requestForBody(body),
      body,
      gateOptions(forwarded),
    );

    // Then only Eve receives the original body and no engine mutation starts
    expect(returnedBody).toBe(body);
    expect(forwarded).toEqual([]);
  });

  it('propagates an engine persistence failure for Telegram retry', async () => {
    // Given an engine-owned group message and an unavailable engine ingress
    const failure = new Error('engine unavailable');
    const update = groupMessageUpdate(401);
    const body = JSON.stringify(update);

    // When the webhook verifier persists the raw update
    const result = verifyAndRouteTelegramWebhook(
      requestForBody(body),
      body,
      {
        lifecycle: new ConciergeLifecycle(),
        secretToken: WEBHOOK_SECRET,
        forward: async () => {
          throw failure;
        },
      },
    );

    // Then the failure remains rejected so Eve returns a non-2xx response
    await expect(result).rejects.toBe(failure);
  });
});

function gateOptions(forwarded: Record<string, unknown>[]): {
  readonly lifecycle: ConciergeLifecycle;
  readonly secretToken: string;
  readonly forward: TelegramForwarder;
} {
  return {
    lifecycle: new ConciergeLifecycle(),
    secretToken: WEBHOOK_SECRET,
    forward: async (update) => {
      forwarded.push(update);
    },
  };
}

function groupMessageUpdate(updateId: number): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: 7,
      date: 1,
      chat: { id: -100, type: 'group', title: 'N5' },
      from: { id: 9, is_bot: false, first_name: 'Ada' },
      text: 'Arsenal score next',
      reply_to_message: { message_id: 6, date: 1, chat: { id: -100, type: 'group', title: 'N5' } },
    },
  };
}

function requestFor(update: Record<string, unknown>, secret: string | undefined): Request {
  const body = JSON.stringify(update);
  const headers = new Headers();
  if (secret !== undefined) {
    headers.set('x-telegram-bot-api-secret-token', secret);
  }
  return new Request('https://callie.example.test/eve/v1/telegram', {
    method: 'POST',
    headers,
    body,
  });
}

function requestForBody(body: string, secret: string | undefined = WEBHOOK_SECRET): Request {
  const headers = new Headers();
  if (secret !== undefined) {
    headers.set('x-telegram-bot-api-secret-token', secret);
  }
  return new Request('https://callie.example.test/eve/v1/telegram', {
    method: 'POST',
    headers,
    body,
  });
}
