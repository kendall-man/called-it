import { describe, expect, it } from 'vitest';
import { dependencyErrorMessage } from './wiring.js';

describe('wiring dependency error narrowing', () => {
  it('returns a stable Error message for log metadata', () => {
    // Given a dependency throws a normal Error
    const error = new Error('upstream unavailable');

    // When wiring prepares stable metadata
    const message = dependencyErrorMessage(error);

    // Then callers get the Error message only
    expect(message).toBe('upstream unavailable');
  });

  it('rethrows unknown thrown values instead of stringifying them', () => {
    // Given a dependency throws a non-Error sentinel
    const thrown = Object.freeze({ secret: 'do-not-stringify' });

    // When wiring prepares stable metadata
    const invoke = () => dependencyErrorMessage(thrown);

    // Then the original value propagates untouched
    try {
      invoke();
    } catch (error) {
      expect(error).toBe(thrown);
      return;
    }
    throw new Error('expected non-Error dependency throw to propagate');
  });
});
