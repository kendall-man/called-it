import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PAGE_PATH = fileURLToPath(new URL('./page.tsx', import.meta.url));

describe('landing actions', () => {
  it('uses the one validated Telegram URL for the header and primary group-add actions', () => {
    // Given
    const pageSource = readFileSync(PAGE_PATH, 'utf8');

    // When
    const activeLinkCount = pageSource.match(/href=\{telegramGroupUrl\}/g)?.length ?? 0;

    // Then
    expect(activeLinkCount).toBe(2);
    expect(pageSource).toContain('buildTelegramGroupAddUrl');
    expect(pageSource).toContain('Add to Telegram group');
    expect(pageSource).not.toMatch(/['"]#[^'"]*['"]/);
    expect(pageSource).not.toMatch(/demo|replay|sample|fake/i);
  });

  it('keeps unavailable configuration and real-content states explicit', () => {
    // Given
    const pageSource = readFileSync(PAGE_PATH, 'utf8');

    // Then
    expect(pageSource).toContain('Telegram setup is unavailable. No call or SOL changed.');
    expect(pageSource).toContain('Settled calls carry their evidence.');
    expect(pageSource).not.toContain('entry_viewed');
    expect(pageSource).not.toContain('add_group_clicked');
  });
});
