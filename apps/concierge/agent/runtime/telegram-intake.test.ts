import { describe, expect, it } from 'vitest';
import {
  routeTelegramCallbackIntake,
  routeTelegramIntake,
} from './telegram-intake.js';
import { ConciergeLifecycle } from './lifecycle.js';

describe('Telegram concierge intake', () => {
  it.each([
    {
      name: 'routes private conversation to Eve',
      message: {
        chat: { type: 'private' },
        text: 'What calls are open?',
        caption: '',
        from: { isBot: false },
      },
      expected: 'concierge',
    },
    {
      name: 'routes a private command to the engine',
      message: {
        chat: { type: 'private' },
        text: '/help',
        caption: '',
        from: { isBot: false },
      },
      expected: 'engine',
    },
    {
      name: 'routes a private bot message to the engine',
      message: {
        chat: { type: 'private' },
        text: 'automated message',
        caption: '',
        from: { isBot: true },
      },
      expected: 'engine',
    },
    {
      name: 'routes plain group chatter to the engine',
      message: {
        chat: { type: 'group' },
        text: 'Arsenal score next',
        caption: '',
        from: { isBot: false },
      },
      expected: 'engine',
    },
    {
      name: 'routes a group command to the engine',
      message: {
        chat: { type: 'supergroup' },
        text: '/bookit',
        caption: '',
        from: { isBot: false },
      },
      expected: 'engine',
    },
    {
      name: 'routes an explicit group mention to the engine consent path',
      message: {
        chat: { type: 'supergroup' },
        text: '@CalledItBot Arsenal score next',
        caption: '',
        from: { isBot: false },
      },
      expected: 'engine',
    },
    {
      name: 'routes a group caption mention to the engine consent path',
      message: {
        chat: { type: 'group' },
        text: '',
        caption: '@CalledItBot Arsenal score next',
        from: { isBot: false },
      },
      expected: 'engine',
    },
  ])('$name', ({ message, expected }) => {
    // Given a Telegram message at the webhook boundary
    const lifecycle = new ConciergeLifecycle();

    // When the webhook selects the update owner
    const route = routeTelegramIntake(message, lifecycle);

    // Then exactly one product surface owns the update
    expect(route).toBe(expected);
  });

  it('refuses the real channel entry decision after draining begins', () => {
    // Given intake has started draining
    const lifecycle = new ConciergeLifecycle();
    lifecycle.beginDrain();

    // When a private message reaches the routing boundary
    const route = routeTelegramIntake(
      {
        chat: { type: 'private' },
        text: 'What calls are open?',
        caption: '',
        from: { isBot: false },
      },
      lifecycle,
    );

    // Then the update is refused without creating unfinished work
    expect(route).toBe('draining');
    expect(lifecycle.unfinished()).toBe(0);
  });

  it('routes an unclaimed callback to the engine', () => {
    // Given the concierge is accepting webhook intake
    const lifecycle = new ConciergeLifecycle();

    // When an engine callback reaches the routing boundary
    const route = routeTelegramCallbackIntake(lifecycle);

    // Then the engine owns the callback
    expect(route).toBe('engine');
  });

  it('refuses callbacks after draining begins', () => {
    // Given intake has started draining
    const lifecycle = new ConciergeLifecycle();
    lifecycle.beginDrain();

    // When a callback reaches the routing boundary
    const route = routeTelegramCallbackIntake(lifecycle);

    // Then the callback is refused
    expect(route).toBe('draining');
  });
});
