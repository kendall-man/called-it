import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('replay receipt presentation', () => {
  it('labels replay receipt, board, and detail surfaces as no-Points replays', async () => {
    const [rows, page, details] = await Promise.all([
      readFile(new URL('./receipt-row.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../app/r/[marketId]/page.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./escrow-receipt.tsx', import.meta.url), 'utf8'),
    ]);

    expect(rows.match(/Past match replay · No points/g)).toHaveLength(2);
    expect(page).toContain('<Badge tone="flood">Past match replay</Badge>');
    expect(page).toContain('<Badge tone="neutral">No points</Badge>');
    expect(details).toContain('Past match · No points');
    expect(`${rows}\n${page}\n${details}`).not.toMatch(/awards? Points|earns? Points|Points earned/i);
  });
});
