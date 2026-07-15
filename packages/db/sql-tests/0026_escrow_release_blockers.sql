begin;

create temp table escrow_0026_legacy_snapshot on commit drop as
select jsonb_build_object(
  'ledger_count', (select count(*) from public.wager_ledger_entries),
  'ledger_total', (select coalesce(sum(lamports), 0) from public.wager_ledger_entries),
  'deposit_count', (select count(*) from public.wager_deposits),
  'withdrawal_count', (select count(*) from public.wager_withdrawals)
) as value;

insert into public.groups (id, title, slug, web_enabled)
values
  (926001, 'Escrow 0026 test', 'escrow-0026-test', true),
  (926010, 'Escrow rollout enabled', 'escrow-rollout-enabled', false),
  (926011, 'Escrow rollout disabled', 'escrow-rollout-disabled', false);

insert into public.users (id, display_name, username)
values (926101, 'PRIVATE_0026_USER', 'private_0026_user');

insert into public.escrow_group_rollouts (
  group_id, custody_mode, cluster, genesis_hash, program_id, custody_version,
  enabled_by, updated_at
) values (
  926001, 'escrow', 'devnet', 'Genesis926', 'Program926', 2, 926101,
  '2026-07-15T09:00:00Z'
);

insert into public.fixtures (
  fixture_id, competition_id, p1_name, p2_name, kickoff_at, phase
) values
  (926201, 1, 'Close FC', 'Dust FC', '2026-07-15T10:00:00Z', 'F'),
  (926202, 1, 'Queue FC', 'Oracle FC', '2026-07-16T10:00:00Z', 'NS'),
  (926210, 1, 'Legacy Before FC', 'Rollout FC', '2026-07-17T10:00:00Z', 'NS'),
  (926211, 1, 'Enabled After FC', 'Rollout FC', '2026-07-18T10:00:00Z', 'NS'),
  (926212, 1, 'Disabled FC', 'Rollout FC', '2026-07-19T10:00:00Z', 'NS');

insert into public.claims (
  id, group_id, claimer_user_id, tg_message_id, quoted_text, status
) values
  ('92600000-0000-4000-8000-000000000001', 926001, 926101, 1, 'PRIVATE CLOSE CLAIM', 'confirmed'),
  ('92600000-0000-4000-8000-000000000002', 926001, 926101, 2, 'PRIVATE QUEUE CLAIM', 'confirmed'),
  ('92600000-0000-4000-8000-000000000009', 926010, 926101, 9, 'PRIVATE LEGACY BEFORE CLAIM', 'confirmed'),
  ('92600000-0000-4000-8000-000000000010', 926010, 926101, 10, 'PRIVATE ENABLED AFTER CLAIM', 'confirmed'),
  ('92600000-0000-4000-8000-000000000011', 926011, 926101, 11, 'PRIVATE DISABLED CLAIM', 'confirmed');

-- A caller cannot opt into escrow without rollout truth. This row predates
-- activation and must remain legacy after the group is enabled.
insert into public.markets (
  id, claim_id, group_id, fixture_id, spec, status, is_replay,
  price_provenance, quote_probability, quote_multiplier, currency, custody_mode
) values (
  '92600000-0000-4000-8000-000000000109',
  '92600000-0000-4000-8000-000000000009', 926010, 926210,
  '{"claimType":"btts","fixtureId":926210,"entityRef":{"kind":"team","participant":1,"name":"Legacy Before FC"},"comparator":"eq","threshold":1,"period":"FT_90","trustTier":"chain_proven"}'::jsonb,
  'open', false, 'market', 0.5, 2, 'sol', 'escrow'
);

select public.escrow_configure_group_rollout(
  926010, 'escrow', 'devnet', 'Genesis926', 'Program926', 2, 926101,
  '2026-07-15T09:01:00Z'
);
select public.escrow_configure_group_rollout(
  926011, 'legacy', null, null, null, null, 926101,
  '2026-07-15T09:01:00Z'
);

insert into public.markets (
  id, claim_id, group_id, fixture_id, spec, status, is_replay,
  price_provenance, quote_probability, quote_multiplier, currency, custody_mode
) values
  (
    '92600000-0000-4000-8000-000000000110',
    '92600000-0000-4000-8000-000000000010', 926010, 926211,
    '{"claimType":"btts","fixtureId":926211,"entityRef":{"kind":"team","participant":1,"name":"Enabled After FC"},"comparator":"eq","threshold":1,"period":"FT_90","trustTier":"chain_proven"}'::jsonb,
    'open', false, 'market', 0.5, 2, 'sol', 'legacy'
  ),
  (
    '92600000-0000-4000-8000-000000000111',
    '92600000-0000-4000-8000-000000000011', 926011, 926212,
    '{"claimType":"btts","fixtureId":926212,"entityRef":{"kind":"team","participant":1,"name":"Disabled FC"},"comparator":"eq","threshold":1,"period":"FT_90","trustTier":"chain_proven"}'::jsonb,
    'open', false, 'market', 0.5, 2, 'sol', 'escrow'
  );

do $$
declare
  v_rollout jsonb;
begin
  if (select custody_mode from public.markets where id = '92600000-0000-4000-8000-000000000109') <> 'legacy' then
    raise exception 'existing legacy market was auto-migrated';
  end if;
  if (select custody_mode from public.markets where id = '92600000-0000-4000-8000-000000000110') <> 'escrow' then
    raise exception 'enabled rollout did not stamp escrow custody';
  end if;
  if (select custody_mode from public.markets where id = '92600000-0000-4000-8000-000000000111') <> 'legacy' then
    raise exception 'disabled rollout did not stamp legacy custody';
  end if;
  v_rollout := public.escrow_get_group_rollout(926010);
  if v_rollout ->> 'found' <> 'true'
     or v_rollout ->> 'genesis_hash' <> 'Genesis926'
     or v_rollout ->> 'custody_version' <> '2' then
    raise exception 'configured rollout readback mismatch';
  end if;

  begin
    perform public.escrow_relayer_enqueue(
      'market_initialization', 'wrong-init-genesis-926', 'devnet', 'Program926',
      'escrow', 2, '92600000-0000-4000-8000-000000000110', null,
      '{"cluster":"devnet","genesisHash":"WrongGenesis926","programId":"Program926"}'::jsonb,
      '2026-07-15T09:02:00Z', 3, 60000, '2026-07-15T09:02:00Z'
    );
    raise exception 'wrong initialization genesis was accepted';
  exception when others then
    if sqlerrm <> 'escrow_relayer_group_rollout_mismatch' then raise; end if;
  end;
end;
$$;

insert into public.markets (
  id, claim_id, group_id, fixture_id, spec, status, is_replay,
  price_provenance, quote_probability, quote_multiplier, currency, custody_mode
) values
  (
    '92600000-0000-4000-8000-000000000101',
    '92600000-0000-4000-8000-000000000001',
    926001,
    926201,
    '{"claimType":"match_winner","fixtureId":926201,"entityRef":{"kind":"team","participant":1,"name":"Close FC"},"comparator":"eq","threshold":1,"period":"FT","trustTier":"chain_proven"}'::jsonb,
    'settled', false, 'market', 0.4, 2.5, 'sol', 'escrow'
  ),
  (
    '92600000-0000-4000-8000-000000000102',
    '92600000-0000-4000-8000-000000000002',
    926001,
    926202,
    '{"claimType":"btts","fixtureId":926202,"entityRef":{"kind":"team","participant":1,"name":"Queue FC"},"comparator":"eq","threshold":1,"period":"FT_90","trustTier":"chain_proven"}'::jsonb,
    'open', false, 'market', 0.5, 2, 'usdc', 'escrow'
  );

insert into public.escrow_chain_event_identities (
  signature, instruction_index, cluster, program_id, event_kind, slot,
  commitment, canonical, observed_at, finalized_at
) values
  ('close-init-926', 0, 'devnet', 'Program926', 'market', 926301, 'finalized', true, now(), now()),
  ('queue-init-926', 0, 'devnet', 'Program926', 'market', 926302, 'finalized', true, now(), now()),
  ('close-settle-926', 1, 'devnet', 'Program926', 'settlement', 926303, 'finalized', true, now(), now());

insert into public.escrow_market_links (
  market_id, custody_version, cluster, genesis_hash, program_id, market_pda,
  vault_pda, asset, mint_pubkey, document_hash_hex, initialize_signature,
  initialize_instruction_index, initialize_slot, initialize_block_time,
  oracle_epoch, event_epoch, ratio_milli, chain_state, commitment, canonical,
  finalized_at, created_at, updated_at
) values
  (
    '92600000-0000-4000-8000-000000000101', 2, 'devnet', 'Genesis926',
    'Program926', 'CloseMarketPda926', 'CloseVaultPda926', 'sol', null,
    repeat('a', 64), 'close-init-926', 0, 926301, '2026-07-15T10:00:00Z',
    9, 4, 1500, 'settled', 'finalized', true, now(), now(), now()
  ),
  (
    '92600000-0000-4000-8000-000000000102', 2, 'devnet', 'Genesis926',
    'Program926', 'QueueMarketPda926', 'QueueVaultPda926', 'usdc', 'UsdcMint926',
    repeat('b', 64), 'queue-init-926', 0, 926302, '2026-07-15T10:01:00Z',
    9, 4, 1000, 'open', 'finalized', true, now(), now(), now()
  );

insert into public.escrow_settlement_events (
  signature, instruction_index, market_id, program_id, outcome,
  evidence_hash_hex, document_hash_hex, oracle_epoch, slot, block_time,
  commitment, canonical, observed_at, finalized_at
) values (
  'close-settle-926', 1,
  '92600000-0000-4000-8000-000000000101', 'Program926', 'claim_won',
  repeat('c', 64), repeat('a', 64), 9, 926303, '2026-07-15T10:02:00Z',
  'finalized', true, now(), now()
);

do $$
begin
  begin
    update public.escrow_group_rollouts
    set genesis_hash = 'WrongGenesis926'
    where group_id = 926001;
    perform public.escrow_relayer_enqueue(
      'freeze', 'wrong-linked-genesis-926', 'devnet', 'Program926', 'escrow', 2,
      '92600000-0000-4000-8000-000000000102', null,
      '{"request":"freeze"}'::jsonb, '2026-07-15T10:02:30Z', 3, 60000,
      '2026-07-15T10:02:30Z'
    );
    raise exception 'wrong rollout genesis was accepted';
  exception when others then
    if sqlerrm <> 'escrow_relayer_group_rollout_mismatch' then raise; end if;
  end;
end;
$$;

do $$
declare
  v_result jsonb;
  v_link public.escrow_market_links%rowtype;
begin
  v_result := public.escrow_index_market_closed(
    'close-event-926', 2, '92600000-0000-4000-8000-000000000101',
    'devnet', 'Genesis926', 'Program926', 'CloseMarketPda926', repeat('a', 64),
    'sol', 17, 926304, '2026-07-15T10:03:00Z', 'finalized', '2026-07-15T10:03:05Z'
  );
  if v_result <> '{"ok":true,"duplicate":false,"finalized":true}'::jsonb then
    raise exception 'market close first projection failed: %', v_result;
  end if;

  v_result := public.escrow_index_market_closed(
    'close-event-926', 2, '92600000-0000-4000-8000-000000000101',
    'devnet', 'Genesis926', 'Program926', 'CloseMarketPda926', repeat('a', 64),
    'sol', 17, 926304, '2026-07-15T10:03:00Z', 'finalized', '2026-07-15T10:03:05Z'
  );
  if v_result ->> 'duplicate' <> 'true' then
    raise exception 'market close exact duplicate failed';
  end if;

  select * into v_link from public.escrow_market_links
  where market_id = '92600000-0000-4000-8000-000000000101';
  if v_link.chain_state <> 'closed'
     or v_link.initialize_signature <> 'close-init-926'
     or v_link.initialize_instruction_index <> 0
     or v_link.initialize_slot <> 926301
     or v_link.document_hash_hex <> repeat('a', 64) then
    raise exception 'market close mutated immutable initialization identity';
  end if;
end;
$$;

do $$
begin
  begin
    perform public.escrow_index_market_closed(
      'close-event-926', 2, '92600000-0000-4000-8000-000000000101',
      'devnet', 'Genesis926', 'Program926', 'CloseMarketPda926', repeat('a', 64),
      'sol', 18, 926304, '2026-07-15T10:03:00Z', 'finalized', '2026-07-15T10:03:05Z'
    );
    raise exception 'market close conflict was accepted';
  exception when others then
    if sqlerrm <> 'escrow_market_closed_identity_conflict' then raise; end if;
  end;

  begin
    perform public.escrow_index_market_closed(
      'wrong-state-close-926', 0, '92600000-0000-4000-8000-000000000102',
      'devnet', 'Genesis926', 'Program926', 'QueueMarketPda926', repeat('b', 64),
      'usdc', 0, 926305, null, 'finalized', '2026-07-15T10:04:00Z'
    );
    raise exception 'nonterminal market close was accepted';
  exception when others then
    if sqlerrm <> 'escrow_market_closed_terminal_state_required' then raise; end if;
  end;

  begin
    perform public.escrow_index_market_closed(
      'close-event-926', 2, '92600000-0000-4000-8000-000000000101',
      'mainnet-beta', 'Genesis926', 'Program926', 'CloseMarketPda926', repeat('a', 64),
      'sol', 17, 926304, '2026-07-15T10:03:00Z', 'finalized', '2026-07-15T10:03:05Z'
    );
    raise exception 'wrong close deployment was accepted';
  exception when others then
    if sqlerrm <> 'escrow_market_closed_deployment_mismatch' then raise; end if;
  end;

  begin
    perform public.escrow_index_market_closed(
      'close-event-926', 2, '92600000-0000-4000-8000-000000000101',
      'devnet', 'Genesis926', 'Program926', 'CloseMarketPda926', repeat('f', 64),
      'sol', 17, 926304, '2026-07-15T10:03:00Z', 'finalized', '2026-07-15T10:03:05Z'
    );
    raise exception 'wrong close document was accepted';
  exception when others then
    if sqlerrm <> 'escrow_market_closed_document_mismatch' then raise; end if;
  end;
end;
$$;

do $$
begin
  if not exists (
    select 1 from public.public_escrow_receipts
    where market_id = '92600000-0000-4000-8000-000000000101'
      and chain_state = 'closed'
      and status = 'settled'
      and settlement_signature = 'close-settle-926'
  ) then
    raise exception 'public receipt regression after close';
  end if;
end;
$$;

do $$
declare
  v_result jsonb;
begin
  v_result := public.escrow_attestation_enqueue(
    repeat('1', 64), 'settle', 'devnet', 'Genesis926', 'Program926', 2,
    '92600000-0000-4000-8000-000000000102', 'QueueMarketPda926', repeat('b', 64),
    9, 4, '{"schemaVersion":1,"outcome":"claim_won"}'::jsonb, repeat('a', 64),
    '2026-07-15T12:00:00Z', '2026-07-15T12:00:10Z', 6, 1000,
    '2026-07-15T12:00:00Z'
  );
  if v_result ->> 'created' <> 'true' then
    raise exception 'attestation enqueue failed';
  end if;

  v_result := public.escrow_attestation_enqueue(
    repeat('1', 64), 'settle', 'devnet', 'Genesis926', 'Program926', 2,
    '92600000-0000-4000-8000-000000000102', 'QueueMarketPda926', repeat('b', 64),
    9, 4, '{"schemaVersion":1,"outcome":"claim_won"}'::jsonb, repeat('a', 64),
    '2026-07-15T12:00:00Z', '2026-07-15T12:00:10Z', 6, 1000,
    '2026-07-15T12:00:00Z'
  );
  if v_result ->> 'created' <> 'false' then
    raise exception 'attestation enqueue exact duplicate failed';
  end if;

  begin
    perform public.escrow_attestation_enqueue(
      repeat('1', 64), 'settle', 'devnet', 'Genesis926', 'Program926', 2,
      '92600000-0000-4000-8000-000000000102', 'QueueMarketPda926', repeat('b', 64),
      9, 4, '{"schemaVersion":1,"outcome":"void"}'::jsonb, repeat('a', 64),
      '2026-07-15T12:00:00Z', '2026-07-15T12:00:10Z', 6, 1000,
      '2026-07-15T12:00:00Z'
    );
    raise exception 'conflicting attestation duplicate was accepted';
  exception when others then
    if sqlerrm <> 'escrow_attestation_idempotency_conflict' then raise; end if;
  end;

  begin
    perform public.escrow_attestation_enqueue(
      repeat('9', 64), 'void', 'devnet', 'Genesis926', 'Program926', 2,
      '92600000-0000-4000-8000-000000000102', 'QueueMarketPda926', repeat('b', 64),
      9, 4, '{"evidence":{"access_token":"private"}}'::jsonb, repeat('9', 64),
      '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z', 2, 1000,
      '2026-07-15T12:00:00Z'
    );
    raise exception 'private attestation payload was accepted';
  exception when others then
    if sqlerrm <> 'escrow_attestation_input_invalid' then raise; end if;
  end;
end;
$$;

create temp table early_lease on commit drop as
select * from public.escrow_attestation_lease(
  'worker-too-early', '2026-07-15T12:00:05Z', 10
);

do $$
begin
  if exists (select 1 from early_lease where request_key = repeat('1', 64)) then
    raise exception 'terminal debounce leased early';
  end if;
end;
$$;

create temp table first_lease on commit drop as
select * from public.escrow_attestation_lease(
  'worker-before-crash', '2026-07-15T12:00:10Z', 1
);

create temp table reclaimed_lease on commit drop as
select * from public.escrow_attestation_lease(
  'worker-after-crash', '2026-07-15T12:00:12Z', 1
);

do $$
declare
  v_old uuid;
  v_new uuid;
  v_result jsonb;
begin
  select lease_token into v_old from first_lease where request_key = repeat('1', 64);
  select lease_token into v_new from reclaimed_lease where request_key = repeat('1', 64);
  if v_old is null or v_new is null or v_old = v_new then
    raise exception 'expired lease was not reclaimed';
  end if;

  v_result := public.escrow_attestation_record_signed(
    repeat('1', 64), 'worker-before-crash', v_old, '2026-07-15T12:00:12.100Z',
    '{"schemaVersion":1,"signatures":["oracle-a"]}'::jsonb, repeat('d', 64)
  );
  if v_result ->> 'code' <> 'lease_lost' then
    raise exception 'stale lease fence was accepted';
  end if;

  v_result := public.escrow_attestation_record_signed(
    repeat('1', 64), 'worker-after-crash', v_new, '2026-07-15T12:00:12.200Z',
    '{"schemaVersion":1,"signatures":["oracle-a"]}'::jsonb, repeat('d', 64)
  );
  if v_result ->> 'state' <> 'signed' then
    raise exception 'signed payload persistence failed';
  end if;
end;
$$;

create temp table signed_restart_lease on commit drop as
select * from public.escrow_attestation_lease(
  'worker-after-signed-crash', '2026-07-15T12:00:14Z', 1
);

do $$
declare
  v_token uuid;
  v_result jsonb;
  v_job_id uuid;
begin
  select lease_token into v_token
  from signed_restart_lease
  where request_key = repeat('1', 64)
    and signed_payload = '{"schemaVersion":1,"signatures":["oracle-a"]}'::jsonb;
  if v_token is null then
    raise exception 'signed intent did not survive restart';
  end if;

  v_result := public.escrow_attestation_record_signed(
    repeat('1', 64), 'worker-after-signed-crash', v_token, '2026-07-15T12:00:14.100Z',
    '{"schemaVersion":1,"signatures":["oracle-a"]}'::jsonb, repeat('d', 64)
  );
  if v_result ->> 'duplicate' <> 'true' then
    raise exception 'signed payload restart idempotency failed';
  end if;

  v_result := public.escrow_relayer_enqueue(
    'settlement_submission', 'attestation-relayer-926', 'devnet', 'Program926',
    'escrow', 2, '92600000-0000-4000-8000-000000000102', null,
    '{"requestKey":"1111111111111111111111111111111111111111111111111111111111111111"}'::jsonb,
    '2026-07-15T12:00:14Z', 4, 60000, '2026-07-15T12:00:14Z'
  );
  v_job_id := (v_result ->> 'job_id')::uuid;

  v_result := public.escrow_attestation_mark_enqueued(
    repeat('1', 64), 'worker-after-signed-crash', v_token,
    '2026-07-15T12:00:14.200Z', v_job_id, '2026-07-15T12:00:14.800Z'
  );
  if v_result ->> 'state' <> 'enqueued' then
    raise exception 'attestation relayer enqueue transition failed';
  end if;

  v_result := public.escrow_attestation_complete(
    repeat('1', 64), 'worker-after-signed-crash', v_token,
    '2026-07-15T12:00:14.225Z'
  );
  if v_result ->> 'code' <> 'relayer_mismatch' then
    raise exception 'attestation completed before relayer completion';
  end if;

  update public.escrow_relayer_jobs
  set state = 'complete', completed_at = '2026-07-15T12:00:14.250Z',
      updated_at = '2026-07-15T12:00:14.250Z'
  where id = v_job_id;

  v_result := public.escrow_attestation_complete(
    repeat('1', 64), 'worker-after-signed-crash', v_token,
    '2026-07-15T12:00:14.300Z'
  );
  if v_result ->> 'state' <> 'completed' then
    raise exception 'attestation completion failed';
  end if;
end;
$$;

-- Two independent due requests are leased to different workers. The SQL RPC
-- uses FOR UPDATE SKIP LOCKED, and the state transition prevents duplicate
-- ownership after either transaction commits.
select public.escrow_attestation_enqueue(
  repeat('2', 64), 'freeze', 'devnet', 'Genesis926', 'Program926', 2,
  '92600000-0000-4000-8000-000000000102', 'QueueMarketPda926', repeat('b', 64),
  9, 4, '{"schemaVersion":1,"reason":"event"}'::jsonb, repeat('2', 64),
  '2026-07-15T13:00:00Z', null, 3, 60000,
  '2026-07-15T13:00:00Z'
);
select public.escrow_attestation_enqueue(
  repeat('3', 64), 'invalidate', 'devnet', 'Genesis926', 'Program926', 2,
  '92600000-0000-4000-8000-000000000102', 'QueueMarketPda926', repeat('b', 64),
  9, 4, '{"schemaVersion":1,"epoch":"4"}'::jsonb, repeat('3', 64),
  '2026-07-15T13:00:00Z', '2026-07-15T13:00:00Z', 3, 60000,
  '2026-07-15T13:00:00Z'
);

create temp table worker_one_lease on commit drop as
select * from public.escrow_attestation_lease('worker-one', '2026-07-15T13:00:00Z', 1);
create temp table worker_two_lease on commit drop as
select * from public.escrow_attestation_lease('worker-two', '2026-07-15T13:00:00Z', 1);

do $$
declare
  v_one text;
  v_two text;
  v_one_token uuid;
  v_two_token uuid;
begin
  select request_key, lease_token into v_one, v_one_token from worker_one_lease;
  select request_key, lease_token into v_two, v_two_token from worker_two_lease;
  if v_one is null or v_two is null or v_one = v_two then
    raise exception 'workers leased the same request';
  end if;
  if not exists (
    select 1 from public.escrow_attestation_requests
    where request_key = repeat('2', 64)
      and debounce_until = due_at
  ) then
    raise exception 'null immediate debounce was not normalized to due_at';
  end if;
  perform public.escrow_attestation_retry(
    v_one, 'worker-one', v_one_token, '2026-07-15T13:00:00.100Z',
    'test_cleanup', '2099-01-01T00:00:00Z'
  );
  perform public.escrow_attestation_retry(
    v_two, 'worker-two', v_two_token, '2026-07-15T13:00:00.100Z',
    'test_cleanup', '2099-01-01T00:00:00Z'
  );
end;
$$;

select public.escrow_attestation_enqueue(
  repeat('5', 64), 'unfreeze', 'devnet', 'Genesis926', 'Program926', 2,
  '92600000-0000-4000-8000-000000000102', 'QueueMarketPda926', repeat('b', 64),
  9, 4, '{"schemaVersion":1,"reason":"resume"}'::jsonb, repeat('5', 64),
  '2026-07-15T13:01:00Z', '2026-07-15T13:01:00Z', 3, 60000,
  '2026-07-15T13:01:00Z'
);
create temp table retry_lease on commit drop as
select * from public.escrow_attestation_lease('retry-worker', '2026-07-15T13:01:00Z', 1);

do $$
declare
  v_token uuid;
  v_result jsonb;
begin
  select lease_token into v_token from retry_lease where request_key = repeat('5', 64);
  v_result := public.escrow_attestation_retry(
    repeat('5', 64), 'retry-worker', gen_random_uuid(), '2026-07-15T13:01:00.100Z',
    'rpc_unavailable', '2026-07-15T13:01:01Z'
  );
  if v_result ->> 'code' <> 'lease_lost' then
    raise exception 'retry stale lease fence was accepted';
  end if;
  v_result := public.escrow_attestation_retry(
    repeat('5', 64), 'retry-worker', v_token, '2026-07-15T13:01:00.100Z',
    'rpc_unavailable', '2099-01-01T00:00:00Z'
  );
  if v_result ->> 'state' <> 'pending' then
    raise exception 'attestation retry did not preserve phase';
  end if;
end;
$$;

select public.escrow_attestation_enqueue(
  repeat('4', 64), 'void', 'devnet', 'Genesis926', 'Program926', 2,
  '92600000-0000-4000-8000-000000000102', 'QueueMarketPda926', repeat('b', 64),
  9, 4, '{"schemaVersion":1,"reason":"timeout"}'::jsonb, repeat('4', 64),
  '2026-07-15T14:00:00Z', '2026-07-15T14:00:00Z', 1, 60000,
  '2026-07-15T14:00:00Z'
);
create temp table failed_lease on commit drop as
select * from public.escrow_attestation_lease('failed-worker', '2026-07-15T14:00:00Z', 1);

do $$
declare
  v_token uuid;
  v_result jsonb;
begin
  select lease_token into v_token from failed_lease where request_key = repeat('4', 64);
  v_result := public.escrow_attestation_retry(
    repeat('4', 64), 'failed-worker', v_token, '2026-07-15T14:00:00.100Z',
    'permanent_failure', '2026-07-15T14:00:01Z'
  );
  if v_result ->> 'state' <> 'failed'
     or not exists (
       select 1 from public.escrow_attestation_requests
       where request_key = repeat('4', 64)
         and state = 'failed'
         and failed_at is not null
         and error_code = 'permanent_failure'
     ) then
    raise exception 'exhausted attestation request was not failed';
  end if;
end;
$$;

do $$
declare
  v_private_columns integer;
  v_current_legacy jsonb;
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
      'request_key', 'lease_owner', 'lease_token', 'unsigned_payload',
      'signed_payload', 'owner_pubkey', 'provider_user_id', 'telegram_user_id'
    );
  if v_private_columns <> 0 then
    raise exception 'public escrow views expose 0026 private state';
  end if;

  if has_table_privilege('anon', 'public.escrow_market_close_events', 'select')
     or has_table_privilege('authenticated', 'public.escrow_attestation_requests', 'select')
     or not has_table_privilege('service_role', 'public.escrow_market_close_events', 'select')
     or not has_table_privilege('service_role', 'public.escrow_attestation_requests', 'select')
     or has_function_privilege(
       'anon',
       'public.escrow_attestation_lease(text,timestamp with time zone,integer)',
       'execute'
     )
     or not has_function_privilege(
       'service_role',
       'public.escrow_attestation_lease(text,timestamp with time zone,integer)',
       'execute'
     )
     or has_function_privilege(
       'anon',
       'public.escrow_configure_group_rollout(bigint,text,text,text,text,integer,bigint,timestamp with time zone)',
       'execute'
     )
     or not has_function_privilege(
       'service_role',
       'public.escrow_configure_group_rollout(bigint,text,text,text,text,integer,bigint,timestamp with time zone)',
       'execute'
     )
     or has_function_privilege(
       'authenticated',
       'public.escrow_get_group_rollout(bigint)',
       'execute'
     )
     or not has_function_privilege(
       'service_role',
       'public.escrow_get_group_rollout(bigint)',
       'execute'
     ) then
    raise exception '0026 grants are not service-role-only';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'escrow_market_close_events'
      and c.relrowsecurity
  ) or not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'escrow_attestation_requests'
      and c.relrowsecurity
  ) then
    raise exception '0026 RLS is disabled';
  end if;

  select jsonb_build_object(
    'ledger_count', (select count(*) from public.wager_ledger_entries),
    'ledger_total', (select coalesce(sum(lamports), 0) from public.wager_ledger_entries),
    'deposit_count', (select count(*) from public.wager_deposits),
    'withdrawal_count', (select count(*) from public.wager_withdrawals)
  ) into v_current_legacy;
  if v_current_legacy is distinct from (select value from escrow_0026_legacy_snapshot) then
    raise exception 'legacy accounting changed';
  end if;
end;
$$;

rollback;
