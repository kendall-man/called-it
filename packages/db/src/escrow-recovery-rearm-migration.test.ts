import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function migration(): Promise<string> {
  return readFile(
    new URL('../migrations/0027_escrow_recovery_rearm.sql', import.meta.url),
    'utf8',
  );
}

async function sqlHarness(): Promise<string> {
  return readFile(
    new URL('../sql-tests/0027_escrow_recovery_rearm.sql', import.meta.url),
    'utf8',
  );
}

describe('0027 escrow recovery rearm contract', () => {
  it('rearms only exhausted unsigned recovery work under the existing identity', async () => {
    const sql = await migration();

    expect(sql).toContain('create or replace function public.escrow_relayer_enqueue');
    expect(sql).toContain("'settlement_submission', 'timeout_monitoring', 'auto_claim', 'account_close'");
    expect(sql).toContain("v_existing.kind <> 'position_placement'");
    expect(sql).toContain("v_existing.state = 'dead'");
    expect(sql).toContain('v_existing.attempts >= v_existing.max_attempts');
    expect(sql).toContain("v_existing.state <> 'leased'");
    expect(sql).toContain('v_existing.lease_expires_at <= p_now');
    expect(sql).toContain("set state = 'pending'");
    expect(sql).toContain('attempts = 0');
    expect(sql).toContain("'rearmed_after_exhaustion:'");
    expect(sql).toContain("'created', false, 'job_id', v_existing.id");
  });

  it('fences completed, confirmed, landed, and signed transaction state', async () => {
    const sql = await migration();
    const rearmUpdate = sql.slice(
      sql.indexOf('update public.escrow_relayer_jobs'),
      sql.indexOf("return jsonb_build_object('ok', true, 'created', false"),
    );

    expect(sql).toContain("v_existing.state <> 'complete'");
    expect(sql).toContain('v_existing.completed_at is null');
    expect(sql).toContain('v_existing.confirmed_at is null');
    expect(sql).toContain('v_existing.raw_transaction is null');
    expect(sql).toContain('v_existing.expected_signature is null');
    expect(sql).toContain("effect.commitment in ('confirmed', 'finalized')");
    expect(rearmUpdate).not.toMatch(/raw_transaction\s*=/);
    expect(rearmUpdate).not.toMatch(/expected_signature\s*=/);
    expect(rearmUpdate).not.toMatch(/confirmed_at\s*=/);
    expect(rearmUpdate).not.toMatch(/completed_at\s*=/);
  });

  it('keeps exact binding and payload conflict checks ahead of rearm', async () => {
    const sql = await migration();
    const conflict = sql.indexOf("raise exception 'escrow_relayer_idempotency_conflict'");
    const rearm = sql.indexOf("set state = 'pending'");

    expect(conflict).toBeGreaterThan(0);
    expect(conflict).toBeLessThan(rearm);
    for (const binding of [
      'kind', 'cluster', 'program_id', 'custody_mode', 'custody_version',
      'market_id', 'owner_pubkey', 'payload',
    ]) expect(sql).toContain(`v_existing.${binding} is distinct from`);
  });

  it('ships executable outage, duplicate-effect, signed-byte, and conflict coverage', async () => {
    const sql = await sqlHarness();

    expect(sql).toContain('outage recovery job did not enter exhausted retry wait');
    expect(sql).toContain('periodic enqueue did not resume leasing');
    expect(sql).toContain('active recovery duplicate behavior changed');
    expect(sql).toContain('completed recovery duplicate behavior changed');
    expect(sql).toContain('ambiguous signed transaction bytes were altered');
    expect(sql).toContain('landed economic effect was duplicated or rearmed');
    expect(sql).toContain('position placement was rearmed');
    expect(sql).toContain('conflicting recovery binding was accepted');
    expect(sql).toContain('conflicting recovery payload was accepted');
  });
});
