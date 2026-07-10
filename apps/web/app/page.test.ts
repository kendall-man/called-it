import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PAGE_PATH = fileURLToPath(new URL('./page.tsx', import.meta.url));
const TELEGRAM_GROUP_URL =
  'https://t.me/footballcallit_bot?startgroup=calledit_v1&admin=manage_chat';

describe('landing actions', () => {
  it('sends the visible add action to the real versioned Telegram group link', () => {
    // Given
    const pageSource = readFileSync(PAGE_PATH, 'utf8');

    // When
    const activeLinkCount = pageSource.split(TELEGRAM_GROUP_URL).length - 1;

    // Then
    expect(activeLinkCount).toBe(1);
    expect(pageSource).toContain('Add to Telegram group');
    expect(pageSource).not.toMatch(/['"]#[^'"]*['"]/);
    expect(pageSource).not.toMatch(/demo group|sample receipt/i);
  });
});
