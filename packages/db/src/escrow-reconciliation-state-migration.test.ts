import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function migration(): Promise<string> {
  return readFile(
    new URL('../migrations/0034_escrow_reconciliation_state.sql', import.meta.url),
    'utf8',
  );
}

describe('0034 finalized reconciliation market state projection', () => {
  it('projects guarded chain state and event epoch from the newest finalized snapshot', async () => {
    const sql = await migration();

    expect(sql).toContain("p_details ->> 'chainState'");
    expect(sql).toContain("p_details ->> 'eventEpoch'");
    expect(sql).toContain("v_chain_state not in ('open', 'frozen', 'settled', 'voided', 'closed')");
    expect(sql).toContain('current_check.checked_slot = p_checked_slot');
    expect(sql).toContain('chain_state = v_chain_state');
    expect(sql).toContain('event_epoch = v_event_epoch');
  });
});
