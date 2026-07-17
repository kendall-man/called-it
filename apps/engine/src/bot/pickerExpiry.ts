/** Best-effort removal of an amount picker after its durable callback TTL ends. */

export interface KeyboardStripper {
  stripKeyboard(chatId: number, messageId: number): void;
}

function canUnref(timer: ReturnType<typeof setTimeout>): timer is NodeJS.Timeout {
  return typeof timer === 'object' && timer !== null && 'unref' in timer;
}

export function schedulePickerKeyboardExpiry(
  poster: KeyboardStripper,
  chatId: number,
  messageId: number,
  ttlMs: number,
): void {
  const timer = setTimeout(() => poster.stripKeyboard(chatId, messageId), ttlMs);
  if (canUnref(timer)) timer.unref();
}
