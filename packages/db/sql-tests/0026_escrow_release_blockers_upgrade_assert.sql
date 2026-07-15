begin;

do $$
declare
  v_result jsonb;
begin
  if (select custody_mode from public.markets
      where id = '92650000-0000-4000-8000-000000000103') <> 'legacy' then
    raise exception '0026 upgrade auto-migrated existing legacy market';
  end if;

  v_result := public.escrow_index_market_closed(
    'upgrade-close-926', 0, '92650000-0000-4000-8000-000000000101',
    'devnet', 'GenesisUpgrade926', 'ProgramUpgrade926', 'UpgradeMarketPda926',
    repeat('e', 64), 'sol', 3, 926503, '2026-07-15T09:02:00Z',
    'finalized', '2026-07-15T09:02:05Z'
  );
  if v_result ->> 'duplicate' <> 'false'
     or not exists (
       select 1 from public.public_escrow_receipts
       where market_id = '92650000-0000-4000-8000-000000000101'
         and chain_state = 'closed'
         and status = 'settled'
     ) then
    raise exception '0026 upgrade close projection failed';
  end if;

  if not exists (
    select 1 from public.escrow_market_links
    where market_id = '92650000-0000-4000-8000-000000000101'
      and initialize_signature = 'upgrade-init-926'
      and initialize_slot = 926501
      and public_terms_version = 1
  ) then
    raise exception '0026 upgrade changed existing market identity';
  end if;
end;
$$;

do $$
declare
  v_result jsonb;
  v_lease public.escrow_attestation_requests%rowtype;
begin
  v_result := public.escrow_attestation_enqueue(
    repeat('8', 64), 'freeze', 'devnet', 'GenesisUpgrade926',
    'ProgramUpgrade926', 3, '92650000-0000-4000-8000-000000000102',
    'UpgradeQueueMarketPda926', repeat('d', 64), 2, 1,
    '{"schemaVersion":1,"reason":"upgrade"}'::jsonb, repeat('8', 64),
    '2026-07-15T09:04:00Z', null, 3, 60000, '2026-07-15T09:04:00Z'
  );
  if v_result ->> 'created' <> 'true' then
    raise exception '0026 upgrade attestation enqueue failed';
  end if;

  select * into v_lease
  from public.escrow_attestation_lease(
    'upgrade-worker', '2026-07-15T09:04:00Z', 1
  );
  if v_lease.request_key <> repeat('8', 64)
     or v_lease.debounce_until <> v_lease.due_at then
    raise exception '0026 upgrade null-debounce lease failed';
  end if;
end;
$$;

rollback;
