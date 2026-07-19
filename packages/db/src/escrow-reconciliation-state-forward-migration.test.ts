import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function migration(): Promise<string> {
  return readFile(
    new URL('../migrations/0035_escrow_reconciliation_projection_repair.sql', import.meta.url),
    'utf8',
  );
}

describe('0035 finalized reconciliation projection repair', () => {
  it('reinstalls guarded projection and backfills only the latest accepted snapshot', async () => {
    const sql = await migration();

    expect(sql).toContain('create or replace function public.escrow_record_reconciliation');
    expect(sql).toContain('current_check.checked_slot = p_checked_slot');
    expect(sql).toContain("details ->> 'chainState'");
    expect(sql).toContain("details ->> 'eventEpoch'");
    expect(sql).toContain('current_state.checked_slot = checks.checked_slot');
    expect(sql).toContain('chain_state = checks.details ->>');
    expect(sql).toContain('event_epoch = (checks.details ->>');
  });
});
