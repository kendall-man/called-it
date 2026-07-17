import { Api } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { LogFields, Logger } from '../log.js';
import { createPoster } from './poster.js';
import { SendQueue } from './sendQueue.js';

type CapturedWarning = {
  readonly event: string;
  readonly fields: LogFields | undefined;
};

function posterHarness(): {
  readonly api: Api;
  readonly poster: ReturnType<typeof createPoster>;
  readonly queue: SendQueue;
  readonly warnings: CapturedWarning[];
} {
  const warnings: CapturedWarning[] = [];
  const log: Logger = {
    info: () => undefined,
    warn: (event, fields) => warnings.push({ event, fields }),
    error: () => undefined,
    child: () => log,
  };
  const api = new Api('123456:test-token');
  const queue = new SendQueue({ ratePerMinute: 100, collapseMs: 0 });
  return { api, poster: createPoster(api, queue, log), queue, warnings };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('poster presence (react / chatAction)', () => {
  it('sends reactions and chat actions even when the send queue is stopped', async () => {
    // Given a queue that will never run another task (proves budget bypass)
    const harness = posterHarness();
    harness.queue.stop();
    const react = vi.spyOn(harness.api, 'setMessageReaction').mockResolvedValue(true as never);
    const action = vi.spyOn(harness.api, 'sendChatAction').mockResolvedValue(true as never);

    // When presence signals fire
    harness.poster.react(-100, 42, '👀');
    harness.poster.chatAction(-100, 'typing');
    await flushMicrotasks();

    // Then both hit the API directly, without consuming a queue slot
    expect(react).toHaveBeenCalledWith(-100, 42, [{ type: 'emoji', emoji: '👀' }]);
    expect(action).toHaveBeenCalledWith(-100, 'typing');
  });

  it('swallows reaction failures with an identity-free warning', async () => {
    const harness = posterHarness();
    vi.spyOn(harness.api, 'setMessageReaction').mockRejectedValue(
      new Error('chatId=-100 messageId=42 name=Private Group'),
    );

    harness.poster.react(-100, 42, '🏆');
    await flushMicrotasks();

    expect(harness.warnings).toEqual([{ event: 'reaction_failed', fields: undefined }]);
  });

  it('swallows chat action failures with an identity-free warning', async () => {
    const harness = posterHarness();
    vi.spyOn(harness.api, 'sendChatAction').mockRejectedValue(
      new Error('chatId=-100 name=Private Group'),
    );

    harness.poster.chatAction(-100, 'typing');
    await flushMicrotasks();

    expect(harness.warnings).toEqual([{ event: 'chat_action_failed', fields: undefined }]);
  });

  it('invokes onSendFailed (and not onSent) when a post send fails', async () => {
    const harness = posterHarness();
    vi.spyOn(harness.api, 'sendMessage').mockRejectedValue(new Error('boom'));
    let failed = false;
    let sent = false;

    harness.poster.post(-100, 'Card shell', {
      onSent: async () => {
        sent = true;
      },
      onSendFailed: () => {
        failed = true;
      },
    });
    await harness.queue.idle();
    harness.queue.stop();

    expect(failed).toBe(true);
    expect(sent).toBe(false);
  });
});

describe('poster failure logging', () => {
  it('explicitly removes stale buttons when a card edit has no keyboard', async () => {
    const harness = posterHarness();
    const edit = vi.spyOn(harness.api, 'editMessageText').mockResolvedValue({} as never);

    harness.poster.editCard(-100, 'market-1', 200, 'Paused card');
    await harness.queue.idle();
    harness.queue.stop();

    expect(edit).toHaveBeenCalledWith(-100, 200, 'Paused card', expect.objectContaining({
      reply_markup: expect.objectContaining({ inline_keyboard: [] }),
    }));
  });

  it('omits Telegram identity when stripping a keyboard fails', async () => {
    // Given a Telegram failure whose text contains raw identity
    const harness = posterHarness();
    const chatId = -1_006_001_001;
    const messageId = 6_001_002;
    vi.spyOn(harness.api, 'editMessageReplyMarkup').mockRejectedValue(
      new Error(`chatId=${chatId} messageId=${messageId} name=Private Group username=private_group`),
    );

    // When the queued keyboard removal runs
    harness.poster.stripKeyboard(chatId, messageId);
    await harness.queue.idle();
    harness.queue.stop();

    // Then the warning has no identity-bearing fields or exception text
    expect(harness.warnings).toEqual([{ event: 'strip_keyboard_failed', fields: undefined }]);
  });

  it('retains only market identity when a card edit fails', async () => {
    // Given a Telegram failure whose text contains raw identity
    const harness = posterHarness();
    const chatId = -1_006_002_001;
    const messageId = 6_002_002;
    const marketId = '60020000-0000-4000-8000-000000000001';
    vi.spyOn(harness.api, 'editMessageText').mockRejectedValue(
      new Error(`chatId=${chatId} messageId=${messageId} userId=6002003 name=Private User`),
    );

    // When the queued card edit runs
    harness.poster.editCard(chatId, marketId, messageId, 'Updated card');
    await harness.queue.idle();
    harness.queue.stop();

    // Then the warning keeps the domain ID and drops Telegram identity and exception text
    expect(harness.warnings).toEqual([{
      event: 'card_edit_failed',
      fields: { marketId },
    }]);
  });
});
