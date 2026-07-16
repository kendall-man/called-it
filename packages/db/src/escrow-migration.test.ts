import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function migration(): Promise<string> {
  return readFile(new URL('../migrations/0024_escrow.sql', import.meta.url), 'utf8');
}

describe('0024 escrow migration contract', () => {
  it('keeps legacy custody explicit, immutable, and free of automatic balance migration', async () => {
    const sql = await migration();

    expect(sql).toContain("add column custody_mode text not null default 'legacy'");
    expect(sql).toContain('markets_custody_mode_immutable');
    expect(sql).toContain('escrow_market_cannot_use_legacy_accounting');
    expect(sql).toContain("custody_mode              text not null default 'escrow'");
    expect(sql).toContain('custody_version           integer not null');
    expect(sql).toContain('escrow_relayer_group_rollout_mismatch');
    expect(sql).not.toMatch(/insert\s+into\s+public\.wager_ledger_entries/i);
    expect(sql).not.toMatch(/update\s+public\.wager_ledger_entries/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.wager_(?:ledger_entries|deposits|withdrawals)/i);
  });

  it('has globally unique chain identities, finalized projections, and reorg correction', async () => {
    const sql = await migration();

    expect(sql).toContain('primary key (signature, instruction_index)');
    expect(sql).toContain('escrow_assert_chain_identity');
    expect(sql).toContain('escrow_rewind_confirmed_chain');
    expect(sql).toContain('escrow_rewind_crosses_finalized_slot');
    expect(sql).toContain("and commitment = 'finalized'");
    expect(sql).toContain('projection_stale');
  });

  it('stores only hashes for signing tokens and preserves signed bytes across unknown confirmation', async () => {
    const sql = await migration();

    expect(sql).toContain('token_hash                    bytea primary key');
    expect(sql).not.toMatch(/\btoken\s+text\b/i);
    expect(sql).toContain('raw_transaction = case when p_confirmation_unknown then raw_transaction else null end');
    expect(sql).toContain('p_full_history_checked_at is null');
    expect(sql).toContain('p_current_block_height <= v_job.last_valid_block_height');
    expect(sql).toContain('escrow_relayer_idempotency_conflict');
  });

  it('keeps Telegram and wallet identity out of finalized public views', async () => {
    const sql = await migration();
    const publicViews = sql.slice(sql.indexOf('create view public.public_escrow_receipts'), sql.indexOf('-- ── Finalized'));

    expect(publicViews).toContain("commitment = 'finalized'");
    expect(publicViews).not.toContain('owner_pubkey');
    expect(publicViews).not.toContain('destination_pubkey');
    expect(publicViews).not.toContain('provider_user_id');
    expect(publicViews).not.toContain('user_id');
    expect(publicViews).not.toContain('telegram');
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to anon, authenticated, service_role');
  });
});
