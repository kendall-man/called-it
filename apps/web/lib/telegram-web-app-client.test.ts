import { describe, expect, it, vi } from 'vitest';
import {
  closeTelegramWebApp,
  setTelegramClosingConfirmation,
  telegramInitDataFromWebApp,
  telegramStartParamFromWebApp,
  triggerTelegramHapticNotification,
} from './telegram-web-app-client';

describe('Telegram Web App bridge', () => {
  it('reads only non-empty raw initData from the trusted bridge field', () => {
    expect(telegramInitDataFromWebApp({
      Telegram: { WebApp: { initData: 'auth_date=1&hash=signed' } },
    })).toBe('auth_date=1&hash=signed');
    expect(telegramInitDataFromWebApp({
      Telegram: { WebApp: { initData: '' } },
    })).toBeNull();
    expect(telegramInitDataFromWebApp({
      Telegram: { WebApp: { initDataUnsafe: { user: { id: 42 } } } },
    })).toBeNull();
  });

  it('reads a non-empty start_param for routing only', () => {
    expect(telegramStartParamFromWebApp({
      Telegram: { WebApp: { initDataUnsafe: { start_param: 'p-abc-b' } } },
    })).toBe('p-abc-b');
    expect(telegramStartParamFromWebApp({
      Telegram: { WebApp: { initDataUnsafe: { start_param: '' } } },
    })).toBeNull();
    expect(telegramStartParamFromWebApp({
      Telegram: { WebApp: { initDataUnsafe: {} } },
    })).toBeNull();
    expect(telegramStartParamFromWebApp({})).toBeNull();
  });

  it('fires haptic notifications only when the bridge exposes them', () => {
    const notificationOccurred = vi.fn();
    triggerTelegramHapticNotification({
      Telegram: { WebApp: { HapticFeedback: { notificationOccurred } } },
    }, 'success');
    expect(notificationOccurred).toHaveBeenCalledWith('success');
    expect(() => triggerTelegramHapticNotification({}, 'error')).not.toThrow();
    expect(() => triggerTelegramHapticNotification({
      Telegram: { WebApp: { HapticFeedback: {} } },
    }, 'error')).not.toThrow();
  });

  it('toggles the closing confirmation through the guarded bridge calls', () => {
    const enableClosingConfirmation = vi.fn();
    const disableClosingConfirmation = vi.fn();
    const bridge = {
      Telegram: { WebApp: { enableClosingConfirmation, disableClosingConfirmation } },
    };
    setTelegramClosingConfirmation(bridge, true);
    setTelegramClosingConfirmation(bridge, false);
    expect(enableClosingConfirmation).toHaveBeenCalledTimes(1);
    expect(disableClosingConfirmation).toHaveBeenCalledTimes(1);
    expect(() => setTelegramClosingConfirmation({}, true)).not.toThrow();
  });

  it('reports whether the bridge accepted a close request', () => {
    const close = vi.fn();
    expect(closeTelegramWebApp({ Telegram: { WebApp: { close } } })).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(closeTelegramWebApp({ Telegram: { WebApp: {} } })).toBe(false);
    expect(closeTelegramWebApp({})).toBe(false);
    expect(closeTelegramWebApp({
      Telegram: { WebApp: { close: () => { throw new Error('unsupported'); } } },
    })).toBe(false);
  });
});
