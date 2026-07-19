import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('0038 durable claim surface migration', () => {
  it('adds one nullable bigint message id without rewriting existing claims', async () => {
    const sql = await readFile(
      new URL('../migrations/0038_claim_surface_message.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toMatch(/alter table claims/i);
    expect(sql).toMatch(/add column if not exists surface_tg_message_id bigint/i);
    expect(sql).not.toMatch(/not null/i);
  });
});
