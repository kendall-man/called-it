import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function migration(): Promise<string> {
  return readFile(
    new URL('../migrations/0032_escrow_signed_retry.sql', import.meta.url),
    'utf8',
  );
}

describe('0032 signed relayer retry migration', () => {
  it('allows an uncertainty retry after signed bytes are durably recorded', async () => {
    const sql = await migration();

    expect(sql).toContain("v_job.state not in ('leased', 'signed')");
    expect(sql).toContain("v_next_state := 'unknown'");
    expect(sql).toContain('raw_transaction = case when p_confirmation_unknown then raw_transaction else null end');
    expect(sql).toContain('lease_token is distinct from p_lease_token');
  });
});
