begin;

insert into public.groups (id, title, slug, web_enabled)
values (925001, 'Escrow public test', 'escrow-public-test', true);

insert into public.users (id, display_name, username)
values (925101, 'PRIVATE_ESCROW_USER', 'private_escrow_user');

insert into public.fixtures (
  fixture_id, competition_id, p1_name, p2_name, kickoff_at, phase
) values
  (925201, 1, 'North FC', 'South FC', '2026-08-01T12:00:00Z', 'NS'),
  (925202, 1, 'East FC', 'West FC', '2026-07-01T12:00:00Z', 'F'),
  (925203, 1, 'Legacy FC', 'Classic FC', '2026-09-01T12:00:00Z', 'NS'),
  (925204, 1, 'Broken FC', 'Invalid FC', '2026-10-01T12:00:00Z', 'NS');

insert into public.claims (
  id, group_id, claimer_user_id, tg_message_id, quoted_text, status
) values
  ('92500000-0000-4000-8000-000000000001', 925001, 925101, 1, 'PRIVATE LIVE CLAIM', 'confirmed'),
  ('92500000-0000-4000-8000-000000000002', 925001, 925101, 2, 'PRIVATE REPLAY CLAIM', 'confirmed'),
  ('92500000-0000-4000-8000-000000000003', 925001, 925101, 3, 'PRIVATE LEGACY CLAIM', 'confirmed'),
  ('92500000-0000-4000-8000-000000000004', 925001, 925101, 4, 'PRIVATE BROKEN CLAIM', 'confirmed');

insert into public.markets (
  id, claim_id, group_id, fixture_id, spec, status, is_replay,
  price_provenance, quote_probability, quote_multiplier, currency, custody_mode
) values
  (
    '92500000-0000-4000-8000-000000000101',
    '92500000-0000-4000-8000-000000000001',
    925001,
    925201,
    '{"claimType":"match_winner","fixtureId":925201,"entityRef":{"kind":"team","participant":1,"name":"North FC"},"comparator":"eq","threshold":1,"period":"FT","trustTier":"chain_proven"}'::jsonb,
    'open', false, 'market', 0.4, 2.5, 'sol', 'escrow'
  ),
  (
    '92500000-0000-4000-8000-000000000102',
    '92500000-0000-4000-8000-000000000002',
    925001,
    925202,
    '{"claimType":"btts","fixtureId":925202,"entityRef":{"kind":"team","participant":1,"name":"East FC"},"comparator":"eq","threshold":1,"period":"FT_90","trustTier":"chain_proven"}'::jsonb,
    'settled', true, 'modelled', 0.5, 2, 'usdc', 'escrow'
  ),
  (
    '92500000-0000-4000-8000-000000000103',
    '92500000-0000-4000-8000-000000000003',
    925001,
    925203,
    '{"claimType":"totals_ou","fixtureId":925203,"entityRef":{"kind":"team","participant":1,"name":"Legacy FC"},"comparator":"gte","threshold":3,"period":"FT","trustTier":"chain_proven"}'::jsonb,
    'open', false, 'market', 0.5, 2, 'sol', 'legacy'
  ),
  (
    '92500000-0000-4000-8000-000000000104',
    '92500000-0000-4000-8000-000000000004',
    925001,
    925204,
    '{"claimType":"totals_ou","fixtureId":999999,"comparator":"gte","threshold":3,"period":"FT","trustTier":"chain_proven"}'::jsonb,
    'open', false, 'market', 0.5, 2, 'sol', 'escrow'
  );

insert into public.escrow_chain_event_identities (
  signature, instruction_index, cluster, program_id, event_kind, slot,
  commitment, canonical, observed_at, finalized_at
) values
  ('live-init-signature', 0, 'devnet', 'Program925', 'market', 925301, 'finalized', true, now(), now()),
  ('replay-init-signature', 0, 'devnet', 'Program925', 'market', 925302, 'finalized', true, now(), now()),
  ('replay-settle-signature', 1, 'devnet', 'Program925', 'settlement', 925303, 'finalized', true, now(), now()),
  ('broken-init-signature', 0, 'devnet', 'Program925', 'market', 925304, 'finalized', true, now(), now());

insert into public.escrow_market_links (
  market_id, custody_version, cluster, genesis_hash, program_id, market_pda,
  vault_pda, asset, mint_pubkey, document_hash_hex, initialize_signature,
  initialize_instruction_index, initialize_slot, initialize_block_time,
  oracle_epoch, event_epoch, ratio_milli, chain_state, commitment, canonical,
  finalized_at, created_at, updated_at
) values
  (
    '92500000-0000-4000-8000-000000000101', 1, 'devnet', 'Genesis925',
    'Program925', 'LiveMarketPda925', 'LiveVaultPda925', 'sol', null,
    repeat('a', 64), 'live-init-signature', 0, 925301, '2026-07-15T00:00:00Z',
    1, 0, 1500, 'open', 'finalized', true, now(), now(), now()
  ),
  (
    '92500000-0000-4000-8000-000000000102', 1, 'devnet', 'Genesis925',
    'Program925', 'ReplayMarketPda925', 'ReplayVaultPda925', 'usdc', 'UsdcMint925',
    repeat('b', 64), 'replay-init-signature', 0, 925302, '2026-07-15T00:01:00Z',
    1, 0, 1000, 'settled', 'finalized', true, now(), now(), now()
  );

insert into public.escrow_settlement_events (
  signature, instruction_index, market_id, program_id, outcome,
  evidence_hash_hex, document_hash_hex, oracle_epoch, slot, block_time,
  commitment, canonical, observed_at, finalized_at
) values (
  'replay-settle-signature', 1,
  '92500000-0000-4000-8000-000000000102', 'Program925', 'claim_won',
  repeat('c', 64), repeat('b', 64), 1, 925303, '2026-07-15T00:02:00Z',
  'finalized', true, now(), now()
);

do $$
declare
  v_live record;
  v_replay record;
begin
  select * into v_live from public.public_escrow_receipts
  where market_id = '92500000-0000-4000-8000-000000000101';
  if v_live.market_id is null
     or v_live.is_replay
     or v_live.asset <> 'sol'
     or v_live.currency <> 'sol'
     or v_live.status <> 'open'
     or v_live.fixture_id <> 925201
     or v_live.fixture_p1_name <> 'North FC'
     or v_live.fixture_p2_name <> 'South FC'
     or v_live.ratio_milli <> 1500
     or v_live.probability_ppm <> 400000
     or v_live.settlement_signature is not null then
    raise exception 'live standalone escrow receipt contract failed';
  end if;

  select * into v_replay from public.public_escrow_receipts
  where market_id = '92500000-0000-4000-8000-000000000102';
  if v_replay.market_id is null
     or not v_replay.is_replay
     or v_replay.asset <> 'usdc'
     or v_replay.currency <> 'usdc'
     or v_replay.status <> 'settled'
     or v_replay.kickoff_at <> '2026-07-01T12:00:00Z'::timestamptz
     or v_replay.outcome <> 'claim_won'
     or v_replay.settlement_signature <> 'replay-settle-signature'
     or v_replay.settlement_instruction_index <> 1 then
    raise exception 'replay standalone escrow receipt contract failed';
  end if;
end;
$$;

-- The fixture feed may later correct its kickoff, but the published escrow
-- receipt retains the canonical terms captured at initialization.
update public.fixtures
set kickoff_at = '2026-07-02T12:00:00Z'
where fixture_id = 925202;

do $$
begin
  if (select kickoff_at from public.public_escrow_receipts
      where market_id = '92500000-0000-4000-8000-000000000102')
     <> '2026-07-01T12:00:00Z'::timestamptz then
    raise exception 'escrow receipt kickoff snapshot changed';
  end if;
end;
$$;

-- A finalized settlement tied to a different immutable market document is
-- treated as contradictory and the receipt disappears until reconciliation.
update public.escrow_settlement_events
set document_hash_hex = repeat('f', 64)
where market_id = '92500000-0000-4000-8000-000000000102';

do $$
begin
  if exists (
    select 1 from public.public_escrow_receipts
    where market_id = '92500000-0000-4000-8000-000000000102'
  ) then
    raise exception 'conflicting settlement document was published';
  end if;
end;
$$;

update public.escrow_settlement_events
set document_hash_hex = repeat('b', 64)
where market_id = '92500000-0000-4000-8000-000000000102';

-- A malformed source market cannot acquire a public escrow link.
do $$
begin
  begin
    insert into public.escrow_market_links (
      market_id, custody_version, cluster, genesis_hash, program_id, market_pda,
      vault_pda, asset, document_hash_hex, initialize_signature,
      initialize_instruction_index, initialize_slot, oracle_epoch, event_epoch,
      ratio_milli, commitment, canonical, finalized_at, created_at, updated_at
    ) values (
      '92500000-0000-4000-8000-000000000104', 1, 'devnet', 'Genesis925',
      'Program925', 'BrokenMarketPda925', 'BrokenVaultPda925', 'sol', repeat('d', 64),
      'broken-init-signature', 0, 925304, 1, 0, 1000,
      'finalized', true, now(), now(), now()
    );
    raise exception 'expected malformed escrow source rejection';
  exception when others then
    if sqlerrm <> 'escrow_public_market_terms_invalid' then
      raise;
    end if;
  end;
end;
$$;

-- Once linked, the replay flag and public display terms cannot be rewritten.
do $$
begin
  begin
    update public.markets
    set is_replay = false
    where id = '92500000-0000-4000-8000-000000000102';
    raise exception 'expected immutable escrow terms rejection';
  exception when others then
    if sqlerrm <> 'escrow_public_market_terms_immutable' then
      raise;
    end if;
  end;
end;
$$;

do $$
declare
  v_private_columns integer;
  v_public_rows integer;
begin
  select count(*) into v_private_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name in (
      'public_escrow_receipts',
      'public_escrow_position_aggregates',
      'public_escrow_claim_transactions'
    )
    and column_name in (
      'owner_pubkey', 'destination_pubkey', 'provider_user_id',
      'telegram_user_id', 'claimer_user_id', 'display_name', 'username',
      'token_hash', 'raw_transaction', 'quoted_text', 'merkle_proof'
    );
  if v_private_columns <> 0 then
    raise exception 'public escrow views expose identity-bearing columns';
  end if;

  select count(*) into v_public_rows
  from public.public_escrow_receipts
  where row_to_json(public_escrow_receipts)::text like '%PRIVATE_ESCROW_USER%'
     or row_to_json(public_escrow_receipts)::text like '%PRIVATE%CLAIM%';
  if v_public_rows <> 0 then
    raise exception 'public escrow receipt exposes private source data';
  end if;

  if not has_table_privilege('anon', 'public.public_escrow_receipts', 'select')
     or not has_table_privilege('authenticated', 'public.public_escrow_receipts', 'select')
     or not has_table_privilege('service_role', 'public.public_escrow_receipts', 'select')
     or has_table_privilege('anon', 'public.escrow_market_links', 'select')
     or has_table_privilege('authenticated', 'public.escrow_market_links', 'select') then
    raise exception 'public escrow grant contract failed';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'public_escrow_receipts'
      and 'security_barrier=true' = any(coalesce(c.reloptions, array[]::text[]))
  ) then
    raise exception 'public escrow receipt is not a security-barrier view';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'escrow_market_links'
      and c.relrowsecurity
  ) then
    raise exception 'escrow market links lost RLS';
  end if;
end;
$$;

set local role anon;
select market_id, group_slug, is_replay, asset, status
from public.public_escrow_receipts
where group_slug = 'escrow-public-test'
order by market_id;
reset role;

-- Legacy public receipt behavior remains available and unchanged.
do $$
begin
  if not exists (
    select 1 from public.public_receipts
    where market_id = '92500000-0000-4000-8000-000000000103'
      and currency = 'sol'
  ) then
    raise exception 'legacy public receipt regression';
  end if;
end;
$$;

rollback;
