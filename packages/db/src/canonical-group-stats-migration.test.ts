import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function migration(): Promise<string> {
  return readFile(new URL('../migrations/0037_canonical_group_stats.sql', import.meta.url), 'utf8');
}

describe('0037 canonical group stats migration contract', () => {
  it('joins escrow lots to the immutable consumed placement identity', async () => {
    const sql = await migration();

    expect(sql).toContain("market.custody_mode = 'legacy'");
    expect(sql).toContain('public.escrow_position_lots lot');
    expect(sql).toContain('public.escrow_position_accounts account');
    expect(sql).toContain("link.cluster = 'devnet'");
    expect(sql).toContain('public.escrow_signing_sessions signing');
    expect(sql).toContain("signing.state = 'consumed'");
    expect(sql).toContain('signing.user_id');
    expect(sql).toContain('signing.transaction_signature = placed.signature');
    expect(sql).toContain('signing.market_id = lot.market_id');
    expect(sql).toContain('signing.owner_pubkey = lot.owner_pubkey');
    expect(sql).toContain('signing.lot_nonce = lot.lot_nonce');
    expect(sql).toContain('signing.side = lot.side');
    expect(sql).toContain('signing.asset = lot.asset');
    expect(sql).toContain('signing.amount_atomic = lot.amount_atomic');
    expect(sql).toContain('signing.event_epoch = lot.event_epoch');
    expect(sql).not.toContain('public.escrow_wallet_links wallet');
    expect(sql).toContain("lot.commitment = 'finalized'");
    expect(sql).toContain("account.commitment = 'finalized'");
    expect(sql).toContain('lot.canonical');
    expect(sql).toContain('account.canonical');
  });

  it('repairs only empty eligible escrow score sets and rebuilds the cache', async () => {
    const sql = await migration();

    expect(sql).toContain('join public.group_points_applied applied');
    expect(sql).toContain("market.custody_mode = 'escrow'");
    expect(sql).toContain('and not market.is_replay');
    expect(sql).toContain("settlement.tier = 'chain_proven'");
    expect(sql).toContain('where existing.market_id = market.id');
    expect(sql).toContain('having count(distinct conflicting.side) > 1');
    expect(sql).toContain('on conflict (market_id, user_id) do nothing');
    expect(sql).toContain('delete from public.group_player_stats');
    expect(sql).toContain('from public.group_player_stats_from_events stats');
  });

  it('keeps terminal participants visible after their call closes', async () => {
    const sql = await migration();
    const participantRpc = sql.slice(
      sql.indexOf('create or replace function public.group_market_participants'),
      sql.indexOf('-- Repair the narrow historical gap'),
    );

    expect(participantRpc).toContain(
      "source.participant_state in ('pending', 'active', 'refundable', 'claimed')",
    );
  });

  it('derives displayed stats from events and preserves replay exclusion in scoring', async () => {
    const sql = await migration();

    expect(sql).toContain('create view public.group_player_stats_from_events');
    expect(sql).toContain('from public.group_point_events event');
    expect(sql).toContain('if v_is_replay then');
    expect(sql).toContain("'reason', 'replay'");
    expect(sql).toContain('from public.group_market_participant_source source');
  });

  it('keeps every identity-bearing projection private and service-role only', async () => {
    const sql = await migration();

    expect(sql).toContain('with (security_invoker = true)');
    expect(sql).toContain('set search_path = pg_catalog, public');
    expect(sql).toContain('from public, anon, authenticated, service_role');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/grant select[^;]+to (?:public|anon|authenticated)/i);
  });
});
