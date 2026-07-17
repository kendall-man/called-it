import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function migration(): Promise<string> {
  return readFile(
    new URL('../migrations/0033_escrow_unknown_finality.sql', import.meta.url),
    'utf8',
  );
}

describe('0033 ambiguous signed relayer reconciliation migration', () => {
  it('keeps exhausted signed transactions leaseable until chain finality is terminal', async () => {
    const sql = await migration();

    expect(sql).toContain('jobs.attempts < jobs.max_attempts');
    expect(sql).toContain("jobs.state in ('signed', 'submitted', 'unknown')");
    expect(sql).toContain("jobs.state = 'leased' and jobs.lease_expires_at <= p_now");
    expect(sql).toContain('jobs.raw_transaction is not null');
    expect(sql).toContain('jobs.expected_signature is not null');
  });

  it('does not spend attempts beyond the configured bound while observing ambiguity', async () => {
    const sql = await migration();

    expect(sql).toContain('least(jobs.attempts + 1, jobs.max_attempts)');
    expect(sql).toContain('else jobs.attempts + 1');
  });

  it('continues reconciliation after the last row actually returned', async () => {
    const sql = await migration();

    expect(sql).toContain('create or replace function public.escrow_list_reconciliation_links');
    expect(sql).toContain('when (select count(*) from candidates) > p_limit');
    expect(sql).toContain('select market_id from page order by market_id desc limit 1');
    expect(sql).not.toContain('from candidates order by market_id offset p_limit limit 1');
  });
});
