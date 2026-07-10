import { describe, expect, it } from 'vitest';
import { ConciergeLifecycle } from './lifecycle.js';
import { createConciergeSessionEvents } from './session-intake.js';

describe('Eve session lifecycle entry', () => {
  it('rejects a new session during drain while an existing session finishes cleanly', () => {
    const lifecycle = new ConciergeLifecycle();
    const events = createConciergeSessionEvents(lifecycle);

    expect(events.started('existing-session')).toBe(true);
    expect(lifecycle.unfinished()).toBe(1);
    lifecycle.beginDrain();

    expect(() => events.started('late-session')).toThrowError('concierge_draining');
    expect(lifecycle.unfinished()).toBe(1);
    expect(events.completed('existing-session')).toBe(true);
    expect(events.completed('existing-session')).toBe(false);
    expect(lifecycle.unfinished()).toBe(0);
  });
});
