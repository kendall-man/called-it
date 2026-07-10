import { describe, expect, it } from 'vitest';
import { ConciergeLifecycle } from './lifecycle.js';
import {
  forwardEngineCallback,
  forwardEngineMessage,
  type TelegramForwarder,
} from './telegram-forwarding.js';

function failingForwarder(error: Error): TelegramForwarder {
  return async () => {
    throw error;
  };
}

describe('Telegram engine forwarding', () => {
  it('propagates group message forwarding failures for webhook retry', async () => {
    // Given a group message belongs to the engine path
    const failure = new Error('engine unavailable');
    const message = {
      chat: { type: 'group' },
      text: 'Spain win this',
      caption: '',
      from: { isBot: false },
      raw: { chat: { id: -1 }, text: 'Spain win this' },
    };

    // When forwarding fails
    const forward = forwardEngineMessage(
      message,
      new ConciergeLifecycle(),
      failingForwarder(failure),
    );

    // Then the channel can surface the failure to Telegram instead of acking
    await expect(forward).rejects.toBe(failure);
  });

  it('propagates private command forwarding failures for webhook retry', async () => {
    // Given a private command is still engine-owned
    const failure = new Error('engine unavailable');
    const message = {
      chat: { type: 'private' },
      text: '/bookit',
      caption: '',
      from: { isBot: false },
      raw: { chat: { id: 1 }, text: '/bookit' },
    };

    // When forwarding fails
    const forward = forwardEngineMessage(
      message,
      new ConciergeLifecycle(),
      failingForwarder(failure),
    );

    // Then the failure propagates to preserve retry semantics
    await expect(forward).rejects.toBe(failure);
  });

  it('propagates callback forwarding failures for webhook retry', async () => {
    // Given an unclaimed callback belongs to the engine path
    const failure = new Error('engine unavailable');

    // When forwarding fails
    const forward = forwardEngineCallback(
      { id: 'callback-1', data: 'st:market:back:0' },
      new ConciergeLifecycle(),
      failingForwarder(failure),
    );

    // Then the channel does not catch-and-ack the failed callback
    await expect(forward).rejects.toBe(failure);
  });
});
