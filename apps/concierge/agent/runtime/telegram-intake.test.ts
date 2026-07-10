import { describe, expect, it } from 'vitest';
import { routeTelegramIntake } from './telegram-intake.js';
import { ConciergeLifecycle } from './lifecycle.js';

const PRIVATE_MESSAGE = {
  chat: { type: 'private' },
  text: 'What calls are open?',
  caption: '',
  from: { isBot: false },
};

describe('Telegram concierge intake', () => {
  it('routes a conversational message to Eve before draining', () => {
    expect(
      routeTelegramIntake(PRIVATE_MESSAGE, 'CalledItBot', new ConciergeLifecycle()),
    ).toBe('concierge');
  });

  it('refuses the real channel entry decision after draining begins', () => {
    const lifecycle = new ConciergeLifecycle();
    lifecycle.beginDrain();

    expect(routeTelegramIntake(PRIVATE_MESSAGE, 'CalledItBot', lifecycle)).toBe(
      'draining',
    );
    expect(lifecycle.unfinished()).toBe(0);
  });
});
