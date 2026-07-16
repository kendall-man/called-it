import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function migration(): Promise<string> {
  return readFile(
    new URL('../migrations/0025_escrow_public_receipts.sql', import.meta.url),
    'utf8',
  );
}

async function sqlHarness(): Promise<string> {
  return readFile(
    new URL('../sql-tests/0025_escrow_public_receipts.sql', import.meta.url),
    'utf8',
  );
}

function publicReceiptView(sql: string): string {
  const start = sql.indexOf('create or replace view public.public_escrow_receipts');
  const end = sql.indexOf('-- Public aggregate and claim views remain');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('0025 escrow public receipt contract', () => {
  it('appends standalone live and replay receipt terms without removing the 0024 columns', async () => {
    const sql = await migration();
    const view = publicReceiptView(sql);
    const existingColumns = [
      'ml.market_id',
      'g.slug as group_slug',
      'g.web_enabled',
      'ml.cluster',
      'ml.program_id',
      'ml.market_pda',
      'ml.vault_pda',
      'ml.asset',
      'ml.document_hash_hex',
      'ml.initialize_signature',
      'ml.initialize_slot',
      'se.outcome',
      'se.signature as settlement_signature',
      'se.slot as settlement_slot',
      'se.evidence_hash_hex',
      'se.block_time as settled_at',
    ] as const;
    const standaloneColumns = [
      'ml.public_fixture_id as fixture_id',
      'ml.public_fixture_p1_name as fixture_p1_name',
      'ml.public_fixture_p2_name as fixture_p2_name',
      'ml.public_spec as spec',
      'ml.public_replay_flag as is_replay',
      'ml.public_kickoff_at as kickoff_at',
      'ml.public_market_created_at as created_at',
      'ml.public_price_provenance as price_provenance',
      'ml.public_quote_probability as quote_probability',
      'ml.public_quote_multiplier as quote_multiplier',
      'ml.public_probability_ppm as probability_ppm',
      'ml.ratio_milli',
      'ml.asset as currency',
      'ml.genesis_hash',
      'ml.mint_pubkey',
      'ml.custody_version',
      'ml.chain_state',
      'ml.initialize_instruction_index',
      'ml.initialize_block_time',
      'se.instruction_index as settlement_instruction_index',
      'end as status',
    ] as const;

    for (const column of existingColumns) expect(view).toContain(column);
    for (const column of standaloneColumns) expect(view).toContain(column);
    expect(view.indexOf('ml.market_id')).toBeLessThan(view.indexOf('ml.public_fixture_id as fixture_id'));
  });

  it('captures immutable replay and display terms and rejects conflicting new source rows', async () => {
    const sql = await migration();

    expect(sql).toContain('public_terms_version');
    expect(sql).toContain('public_replay_flag');
    expect(sql).toContain('escrow_capture_public_market_terms');
    expect(sql).toContain('escrow_public_market_terms_immutable');
    expect(sql).toContain('escrow_public_market_terms_invalid');
    expect(sql).toContain('escrow_public_market_terms_conflict');
    expect(sql).toContain("jsonb_typeof(v_market.spec) <> 'object'");
    expect(sql).toContain("v_market.spec->>'fixtureId'");
    expect(sql).toContain('new.ratio_milli is distinct from v_expected_ratio');
  });

  it('fails closed on stale, malformed, or contradictory finalized projections', async () => {
    const view = publicReceiptView(await migration());

    expect(view).toContain('ml.public_terms_version = 1');
    expect(view).toContain("m.custody_mode = 'escrow'");
    expect(view).toContain("ml.custody_mode = 'escrow'");
    expect(view).toContain('ml.asset = m.currency');
    expect(view).toContain('ml.public_spec = m.spec');
    expect(view).toContain('ml.public_quote_probability = m.quote_probability');
    expect(view).toContain('not ml.projection_stale');
    expect(view).toContain("ml.commitment = 'finalized'");
    expect(view).toContain("se.commitment = 'finalized'");
    expect(view).toContain('initialize_identity.cluster = ml.cluster');
    expect(view).toContain('settlement_identity.cluster = ml.cluster');
    expect(view).toContain('lower(se.document_hash_hex) = lower(ml.document_hash_hex)');
    expect(view).toContain("se.outcome = 'void'");
    expect(view).toContain("se.outcome in ('claim_won', 'claim_lost')");
  });

  it('keeps every public escrow view aggregate-only and explicitly grants read-only access', async () => {
    const sql = await migration();
    const view = publicReceiptView(sql);
    const forbidden = [
      'owner_pubkey',
      'destination_pubkey',
      'provider_user_id',
      'telegram_user_id',
      'claimer_user_id',
      'display_name',
      'username',
      'token_hash',
      'raw_transaction',
      'quoted_text',
      'merkle_proof',
    ] as const;

    for (const privateColumn of forbidden) expect(view).not.toContain(privateColumn);
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to anon, authenticated, service_role');
    expect(sql).not.toMatch(/create\s+(?:or\s+replace\s+)?view\s+public\.public_escrow_position_aggregates/i);
    expect(sql).not.toMatch(/create\s+(?:or\s+replace\s+)?view\s+public\.public_escrow_claim_transactions/i);
  });

  it('ships executable PostgreSQL coverage for replay, privacy, conflicts, grants, and legacy', async () => {
    const sql = await sqlHarness();

    expect(sql).toContain("v_live.asset <> 'sol'");
    expect(sql).toContain("v_replay.asset <> 'usdc'");
    expect(sql).toContain('conflicting settlement document was published');
    expect(sql).toContain('escrow_public_market_terms_invalid');
    expect(sql).toContain('escrow_public_market_terms_immutable');
    expect(sql).toContain('public escrow views expose identity-bearing columns');
    expect(sql).toContain("has_table_privilege('anon', 'public.public_escrow_receipts', 'select')");
    expect(sql).toContain('legacy public receipt regression');
  });
});
