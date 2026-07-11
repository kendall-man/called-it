import { describe, expect, it } from 'vitest';
import {
  buildTelegramGroupAddUrl,
  TELEGRAM_GROUP_ADMIN_RIGHTS,
  TELEGRAM_STARTGROUP,
} from './entry';

describe('Telegram group entry', () => {
  it('builds the exact versioned group-add URL from a valid bot username', () => {
    // Given
    const botUsername = 'footballcallit_bot';

    // When
    const entryUrl = buildTelegramGroupAddUrl(botUsername);

    // Then
    expect(entryUrl).toBe(
      'https://t.me/footballcallit_bot?startgroup=calledit_v1&admin=manage_chat',
    );
    const parsed = new URL(entryUrl ?? 'https://example.test');
    expect(parsed.searchParams.get('startgroup')).toBe(TELEGRAM_STARTGROUP);
    expect(parsed.searchParams.get('admin')).toBe(TELEGRAM_GROUP_ADMIN_RIGHTS);
  });

  it.each([
    undefined,
    '',
    'not-a-bot',
    'bot?startgroup=elsewhere',
    'footballcallit_bot#fragment',
  ])('fails closed for an invalid bot username: %s', (botUsername) => {
    expect(buildTelegramGroupAddUrl(botUsername)).toBeNull();
  });
});
