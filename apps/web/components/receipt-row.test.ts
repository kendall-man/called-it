import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('receipt row links', () => {
  it('uses the compact receipt helper for receipt and group-board links', async () => {
    const source = await readFile(new URL('./receipt-row.tsx', import.meta.url), 'utf8');

    expect(source).toContain("import { encodeReceiptId } from '@/lib/receipt-id'");
    expect(source).toContain('`/r/${encodeReceiptId(marketId) ?? marketId}`');
    expect(source.match(/href=\{receiptHref\(/g)).toHaveLength(2);
    expect(source).not.toMatch(/href=\{`\/r\/\$\{(?:receipt|market)\.marketId\}`\}/);
  });
});
