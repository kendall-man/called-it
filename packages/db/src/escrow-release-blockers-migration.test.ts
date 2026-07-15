import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function migration(): Promise<string> {
  return readFile(
    new URL('../migrations/0026_escrow_release_blockers.sql', import.meta.url),
    'utf8',
  );
}

async function sqlHarness(): Promise<string> {
  return readFile(
    new URL('../sql-tests/0026_escrow_release_blockers.sql', import.meta.url),
    'utf8',
  );
}

describe('0026 escrow release blocker contract', () => {
  it('projects finalized MarketClosed events without rewriting immutable initialization identity', async () => {
    const sql = await migration();

    expect(sql).toContain('create table public.escrow_market_close_events');
    expect(sql).toContain('create function public.escrow_index_market_closed');
    expect(sql).toContain("p_commitment <> 'finalized'");
    expect(sql).toContain("v_link.chain_state not in ('settled', 'voided')");
    expect(sql).toContain("set chain_state = 'closed'");
    expect(sql).toContain("'market_closed'");
    expect(sql).toContain('escrow_market_closed_identity_conflict');
    expect(sql).not.toMatch(/set\s+initialize_(?:signature|instruction_index|slot)/i);
  });

  it('persists bounded, private, lease-fenced attestation workflow intent', async () => {
    const sql = await migration();

    for (const rpc of [
      'escrow_attestation_enqueue',
      'escrow_attestation_lease',
      'escrow_attestation_record_signed',
      'escrow_attestation_mark_enqueued',
      'escrow_attestation_complete',
      'escrow_attestation_retry',
    ]) expect(sql).toContain(`create function public.${rpc}`);

    expect(sql).toContain('create table public.escrow_attestation_requests');
    expect(sql).toContain("operation_kind in ('freeze', 'unfreeze', 'invalidate', 'settle', 'void')");
    expect(sql).toContain("state in ('pending', 'leased', 'signed', 'enqueued', 'completed', 'failed')");
    expect(sql).toContain('for update skip locked');
    expect(sql).toContain('debounce_until');
    expect(sql).toContain('coalesce(p_debounce_until, p_due_at)');
    expect(sql).toContain('lease_token');
    expect(sql).toContain('escrow_attestation_idempotency_conflict');
    expect(sql).toContain('escrow_attestation_payload_private_safe');
    expect(sql).toContain("'attempts_exhausted'");
    expect(sql).toContain("v_job.state <> 'complete'");
  });

  it('keeps the new contract service-role-only and leaves legacy accounting untouched', async () => {
    const sql = await migration();

    expect(sql).toContain('enable row level security');
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/insert\s+into\s+public\.wager_/i);
    expect(sql).not.toMatch(/update\s+public\.wager_/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.wager_/i);
    expect(sql).not.toMatch(/create\s+(?:or\s+replace\s+)?view\s+public\.public_escrow_receipts/i);
  });

  it('assigns new market custody from exact rollout identity without migrating existing rows', async () => {
    const sql = await migration();

    expect(sql).toContain('create function public.escrow_assign_market_custody_from_rollout');
    expect(sql).toContain('before insert on public.markets');
    expect(sql).toContain("new.custody_mode := 'escrow'");
    expect(sql).toContain("new.custody_mode := 'legacy'");
    expect(sql).toContain('create function public.escrow_configure_group_rollout');
    expect(sql).toContain('create function public.escrow_get_group_rollout');
    expect(sql).toContain('create or replace function public.escrow_validate_relayer_job_custody');
    expect(sql).toContain('v_rollout.genesis_hash is distinct from v_link.genesis_hash');
    expect(sql).toContain("v_rollout.genesis_hash is distinct from new.payload ->> 'genesisHash'");
    expect(sql).not.toMatch(/update\s+public\.markets\s+set\s+custody_mode/i);
  });

  it('ships executable upgrade and fresh coverage for races, restart, privacy, and conflicts', async () => {
    const sql = await sqlHarness();

    expect(sql).toContain('market close exact duplicate failed');
    expect(sql).toContain('market close conflict was accepted');
    expect(sql).toContain('terminal debounce leased early');
    expect(sql).toContain('workers leased the same request');
    expect(sql).toContain('expired lease was not reclaimed');
    expect(sql).toContain('stale lease fence was accepted');
    expect(sql).toContain('private attestation payload was accepted');
    expect(sql).toContain('public receipt regression after close');
    expect(sql).toContain('legacy accounting changed');
    expect(sql).toContain('existing legacy market was auto-migrated');
    expect(sql).toContain('enabled rollout did not stamp escrow custody');
    expect(sql).toContain('disabled rollout did not stamp legacy custody');
    expect(sql).toContain('wrong rollout genesis was accepted');
  });
});
