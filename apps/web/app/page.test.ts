import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PAGE_PATH = fileURLToPath(new URL('./page.tsx', import.meta.url));
const LANDING_COMPONENT_PATH = fileURLToPath(
  new URL('../components/landing-page.tsx', import.meta.url),
);

function readLandingSource(): string {
  return `${readFileSync(PAGE_PATH, 'utf8')}\n${readFileSync(LANDING_COMPONENT_PATH, 'utf8')}`;
}

describe('landing actions', () => {
  it('uses the one validated Telegram URL for the header and primary group-add actions', () => {
    // Given
    const pageSource = readLandingSource();

    // When
    const activeLinkCount = pageSource.match(/href=\{telegramGroupUrl\}/g)?.length ?? 0;

    // Then
    expect(activeLinkCount).toBe(2);
    expect(pageSource).toContain('buildTelegramInstallUrl');
    expect(pageSource).toContain('process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME');
    expect(pageSource).toContain('Add Rumble to your group');
    expect(pageSource).toContain('<QrPanel qrCodeDataUrl={qrCodeDataUrl} />');
    expect(pageSource).not.toContain('access-section');
    expect(pageSource).not.toMatch(/['"]#[^'"]*['"]/);
    expect(pageSource).not.toMatch(/demo|replay|sample|fake/i);
  });

  it('keeps unavailable configuration and real-content states explicit', () => {
    // Given
    const pageSource = readLandingSource();

    // Then
    expect(pageSource).toContain('Telegram setup is unavailable. No call or SOL changed.');
    expect(pageSource).toContain(
      'Rumble is currently in public beta and uses Solana devnet test tokens.',
    );
    expect(pageSource.match(/href=\{TXLINE_URL\}/g)).toHaveLength(2);
    expect(pageSource).toContain('Got a football take?');
    expect(pageSource).toContain('Rumble settles it after the match.');
    expect(pageSource.match(/<RumbleWordmark \/>/g)).toHaveLength(2);
    expect(pageSource).not.toContain('rumble-mark-symbol');
    expect(pageSource).toContain('rumble-wordmark-stop');
    expect(pageSource).not.toContain('<svg viewBox="0 0 20 20"');
    expect(pageSource).toContain('0.08 SOL</dd>');
    expect(pageSource).toContain('Paid to winners');
    expect(pageSource).not.toContain('position-section');
    expect(pageSource).not.toContain('Short answers about SOL, privacy and results.');
    expect(pageSource).toContain('<h2 id="faq-title">FAQ</h2>');
    expect(pageSource).not.toContain('A few things worth knowing.');
    expect(pageSource).toContain('You call it. Rumble settles it.');
    expect(pageSource).not.toMatch(
      /BOT \/ ONLINE|LIVE FOOTBALL CALLS|TELEGRAM NATIVE|CALL_PIPELINE|SYSTEM FLOW|DIRECT ENTRY/,
    );
    expect(pageSource).not.toMatch(
      /Opens Telegram with group setup ready|Same destination as|Point a phone camera|deterministic|requester-scoped/,
    );
    expect(pageSource).not.toContain('entry_viewed');
    expect(pageSource).not.toContain('add_group_clicked');
  });
});
