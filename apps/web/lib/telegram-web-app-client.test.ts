import { describe, expect, it } from 'vitest';
import { telegramInitDataFromWebApp } from './telegram-web-app-client';

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
});
