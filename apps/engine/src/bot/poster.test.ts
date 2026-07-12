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

describe('poster failure logging', () => {
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
