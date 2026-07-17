import { describe, expect, it } from 'vitest';
import { ConciergeLifecycle } from './lifecycle.js';
import {
  forwardEngineEnvelope,
  type TelegramForwarder,
} from './telegram-forwarding.js';

function failingForwarder(error: Error): TelegramForwarder {
  return async () => {
    throw error;
  };
}

describe('Telegram engine forwarding', () => {
  it('propagates group message forwarding failures for webhook retry', async () => {
    // Given a group update belongs to the engine path
    const failure = new Error('engine unavailable');
    const update = {
      update_id: 101,
      message: {
        chat: { id: -1, type: 'group' },
        text: 'Spain win this',
        from: { is_bot: false },
      },
    };

    // When forwarding fails
    const forward = forwardEngineEnvelope(
      update,
      new ConciergeLifecycle(),
      failingForwarder(failure),
    );

    // Then the channel can surface the failure to Telegram instead of acking
    await expect(forward).rejects.toBe(failure);
  });

  it('propagates private command forwarding failures for webhook retry', async () => {
    // Given a private command is still engine-owned
    const failure = new Error('engine unavailable');
    const update = {
      update_id: 102,
      message: {
        chat: { id: 1, type: 'private' },
        text: '/bookit',
        from: { is_bot: false },
      },
    };

    // When forwarding fails
    const forward = forwardEngineEnvelope(
      update,
      new ConciergeLifecycle(),
      failingForwarder(failure),
    );

    // Then the failure propagates to preserve retry semantics
    await expect(forward).rejects.toBe(failure);
  });

  it('propagates callback forwarding failures for webhook retry', async () => {
    // Given a callback belongs to the engine path
    const failure = new Error('engine unavailable');
    const update = {
      update_id: 103,
      callback_query: { id: 'callback-1', data: 'st:market:back:0' },
    };

    // When forwarding fails
    const forward = forwardEngineEnvelope(
      update,
      new ConciergeLifecycle(),
      failingForwarder(failure),
    );

    // Then the channel does not catch-and-ack the failed callback
    await expect(forward).rejects.toBe(failure);
  });
});
