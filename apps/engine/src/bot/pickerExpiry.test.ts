import { afterEach, describe, expect, it, vi } from 'vitest';
import { schedulePickerKeyboardExpiry } from './pickerExpiry.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('picker keyboard expiry', () => {
  it('strips a picker keyboard exactly when its two-minute TTL ends', () => {
    vi.useFakeTimers();
    const stripped: Array<{ chatId: number; messageId: number }> = [];

    schedulePickerKeyboardExpiry(
      { stripKeyboard: (chatId, messageId) => stripped.push({ chatId, messageId }) },
      -1001,
      77,
      120_000,
    );

    vi.advanceTimersByTime(119_999);
    expect(stripped).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stripped).toEqual([{ chatId: -1001, messageId: 77 }]);
  });
});
