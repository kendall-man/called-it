import { describe, expect, it, vi } from 'vitest';
import { ConciergeLifecycle } from './lifecycle.js';
import { forwardEngineMessage, type TelegramForwarder } from './telegram-forwarding.js';
import {
  CHATSDK_TELEGRAM_ROUTE,
  conciergeDispatchFor,
  conciergeLoopbackOrigin,
  createConciergeLoopback,
  type ConciergeDispatchAction,
} from './chatsdk-loopback.js';

const noopForwarder: TelegramForwarder = async () => {};

function messageFor(fields: {
  chatType: string;
  text: string;
  isBot?: boolean;
}): Parameters<typeof forwardEngineMessage>[0] {
  return {
    chat: { type: fields.chatType },
    text: fields.text,
    caption: '',
    from: { isBot: fields.isBot ?? false },
    raw: { chat: { id: 1 }, from: { id: 1 }, text: fields.text },
  };
}

async function dispatchActionFor(
  message: Parameters<typeof forwardEngineMessage>[0],
  lifecycle: ConciergeLifecycle,
): Promise<ConciergeDispatchAction> {
  const destination = await forwardEngineMessage(message, lifecycle, noopForwarder);
  return conciergeDispatchFor(destination);
}

describe('conciergeDispatchFor', () => {
  it('loops back conversational, forwards engine-handled, drops draining', () => {
    expect(conciergeDispatchFor('concierge')).toBe('loopback');
    expect(conciergeDispatchFor('handled')).toBe('engine');
    expect(conciergeDispatchFor('draining')).toBe('drop');
  });
});

describe('front-door loopback routing decision', () => {
  it('routes a conversational private message to the loopback', async () => {
    const action = await dispatchActionFor(
      messageFor({ chatType: 'private', text: 'what calls are open?' }),
      new ConciergeLifecycle(),
    );
    expect(action).toBe('loopback');
  });

  it.each([
    { name: 'private command', chatType: 'private', text: '/help' },
    { name: 'group chatter', chatType: 'group', text: 'Arsenal score next' },
    { name: 'group command', chatType: 'supergroup', text: '/bookit' },
  ])('routes $name to the engine', async ({ chatType, text }) => {
    const action = await dispatchActionFor(
      messageFor({ chatType, text }),
      new ConciergeLifecycle(),
    );
    expect(action).toBe('engine');
  });

  it('drops any update once draining begins', async () => {
    const lifecycle = new ConciergeLifecycle();
    lifecycle.beginDrain();
    const action = await dispatchActionFor(
      messageFor({ chatType: 'private', text: 'still there?' }),
      lifecycle,
    );
    expect(action).toBe('drop');
  });
});

describe('createConciergeLoopback', () => {
  it('POSTs the wrapped update to the bridge route with the webhook secret', async () => {
    const captured: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      captured.push({ url: String(input), init });
      return Response.json({ ok: true });
    };
    const loopback = createConciergeLoopback({
      origin: conciergeLoopbackOrigin(8080),
      route: CHATSDK_TELEGRAM_ROUTE,
      secretToken: 'webhook-secret-token-with-32-bytes',
      fetch: fetchStub,
      nextUpdateId: () => 777,
    });

    const raw = { message_id: 3, chat: { id: 9 }, from: { id: 9 }, text: 'hi' };
    await loopback.dispatch(raw);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('http://127.0.0.1:8080/eve/v1/callie');
    expect(captured[0]?.init?.method).toBe('POST');
    expect(captured[0]?.init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'webhook-secret-token-with-32-bytes',
    });
    expect(captured[0]?.init?.body).toBe(JSON.stringify({ update_id: 777, message: raw }));
  });

  it('swallows and logs a failed loopback so the front door still acks Telegram', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const loopback = createConciergeLoopback({
      origin: conciergeLoopbackOrigin(8080),
      route: CHATSDK_TELEGRAM_ROUTE,
      secretToken: 'secret',
      fetch: async () => {
        throw new Error('bridge route unreachable');
      },
    });

    // Then dispatch never rejects (a lost reply must not fail the webhook)
    await expect(loopback.dispatch({ chat: { id: 1 } })).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('chatsdk_loopback_failed');
    stderr.mockRestore();
  });

  it('logs when the bridge route returns a non-ok status', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const loopback = createConciergeLoopback({
      origin: 'http://127.0.0.1:8080',
      route: CHATSDK_TELEGRAM_ROUTE,
      secretToken: 'secret',
      fetch: async () => new Response('nope', { status: 403 }),
    });

    await loopback.dispatch({ chat: { id: 1 } });
    expect(String(stderr.mock.calls[0]?.[0])).toContain('chatsdk_loopback_status_403');
    stderr.mockRestore();
  });
});
