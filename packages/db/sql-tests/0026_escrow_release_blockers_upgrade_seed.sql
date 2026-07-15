insert into public.groups (id, title, slug, web_enabled)
values
  (-1000000926501, 'Escrow 0026 upgrade', 'escrow-0026-upgrade', true),
  (-1000000926502, 'Escrow legacy upgrade', 'escrow-legacy-upgrade', false);

insert into public.users (id, display_name, username)
values (926501, 'PRIVATE_UPGRADE_USER', 'private_upgrade_user');

insert into public.escrow_group_rollouts (
  group_id, custody_mode, cluster, genesis_hash, program_id, custody_version,
  enabled_by, updated_at
) values (
  -1000000926501, 'escrow', 'devnet', 'GenesisUpgrade926', 'ProgramUpgrade926', 3,
  926501, '2026-07-15T08:00:00Z'
);

insert into public.fixtures (
  fixture_id, competition_id, p1_name, p2_name, kickoff_at, phase
) values
  (926501, 1, 'Upgrade FC', 'Existing FC', '2026-07-15T09:00:00Z', 'F'),
  (926502, 1, 'Queue Upgrade FC', 'Existing Queue FC', '2026-07-16T09:00:00Z', 'NS'),
  (926503, 1, 'Legacy Upgrade FC', 'Existing Legacy FC', '2026-07-17T09:00:00Z', 'NS');

insert into public.claims (
  id, group_id, claimer_user_id, tg_message_id, quoted_text, status
) values
  (
    '92650000-0000-4000-8000-000000000001', -1000000926501, 926501, 1,
    'PRIVATE UPGRADE CLAIM', 'confirmed'
  ),
  (
    '92650000-0000-4000-8000-000000000002', -1000000926501, 926501, 2,
    'PRIVATE UPGRADE QUEUE CLAIM', 'confirmed'
  ),
  (
    '92650000-0000-4000-8000-000000000003', -1000000926502, 926501, 3,
    'PRIVATE UPGRADE LEGACY CLAIM', 'confirmed'
  );

insert into public.markets (
  id, claim_id, group_id, fixture_id, spec, status, is_replay,
  price_provenance, quote_probability, quote_multiplier, currency, custody_mode
) values
  (
    '92650000-0000-4000-8000-000000000101',
    '92650000-0000-4000-8000-000000000001',
    -1000000926501,
    926501,
    '{"claimType":"match_winner","fixtureId":926501,"entityRef":{"kind":"team","participant":1,"name":"Upgrade FC"},"comparator":"eq","threshold":1,"period":"FT","trustTier":"chain_proven"}'::jsonb,
    'settled', false, 'market', 0.5, 2, 'sol', 'escrow'
  ),
  (
    '92650000-0000-4000-8000-000000000102',
    '92650000-0000-4000-8000-000000000002',
    -1000000926501,
    926502,
    '{"claimType":"btts","fixtureId":926502,"entityRef":{"kind":"team","participant":1,"name":"Queue Upgrade FC"},"comparator":"eq","threshold":1,"period":"FT_90","trustTier":"chain_proven"}'::jsonb,
    'open', false, 'market', 0.5, 2, 'usdc', 'escrow'
  ),
  (
    '92650000-0000-4000-8000-000000000103',
    '92650000-0000-4000-8000-000000000003',
    -1000000926502,
    926503,
    '{"claimType":"btts","fixtureId":926503,"entityRef":{"kind":"team","participant":1,"name":"Legacy Upgrade FC"},"comparator":"eq","threshold":1,"period":"FT_90","trustTier":"chain_proven"}'::jsonb,
    'open', false, 'market', 0.5, 2, 'sol', 'legacy'
  );

insert into public.escrow_chain_event_identities (
  signature, instruction_index, cluster, program_id, event_kind, slot,
  commitment, canonical, observed_at, finalized_at
) values
  ('upgrade-init-926', 0, 'devnet', 'ProgramUpgrade926', 'market', 926501, 'finalized', true, now(), now()),
  ('upgrade-queue-init-926', 0, 'devnet', 'ProgramUpgrade926', 'market', 926504, 'finalized', true, now(), now()),
  ('upgrade-settle-926', 0, 'devnet', 'ProgramUpgrade926', 'settlement', 926502, 'finalized', true, now(), now());

insert into public.escrow_market_links (
  market_id, custody_version, cluster, genesis_hash, program_id, market_pda,
  vault_pda, asset, mint_pubkey, document_hash_hex, initialize_signature,
  initialize_instruction_index, initialize_slot, initialize_block_time,
  oracle_epoch, event_epoch, ratio_milli, chain_state, commitment, canonical,
  finalized_at, created_at, updated_at
) values
  (
    '92650000-0000-4000-8000-000000000101', 3, 'devnet', 'GenesisUpgrade926',
    'ProgramUpgrade926', 'UpgradeMarketPda926', 'UpgradeVaultPda926', 'sol', null,
    repeat('e', 64), 'upgrade-init-926', 0, 926501, '2026-07-15T09:00:00Z',
    2, 1, 1000, 'settled', 'finalized', true, now(), now(), now()
  ),
  (
    '92650000-0000-4000-8000-000000000102', 3, 'devnet', 'GenesisUpgrade926',
    'ProgramUpgrade926', 'UpgradeQueueMarketPda926', 'UpgradeQueueVaultPda926',
    'usdc', 'UpgradeUsdcMint926', repeat('d', 64), 'upgrade-queue-init-926', 0,
    926504, '2026-07-15T09:03:00Z', 2, 1, 1000, 'open', 'finalized', true,
    now(), now(), now()
  );

insert into public.escrow_settlement_events (
  signature, instruction_index, market_id, program_id, outcome,
  evidence_hash_hex, document_hash_hex, oracle_epoch, slot, block_time,
  commitment, canonical, observed_at, finalized_at
) values (
  'upgrade-settle-926', 0,
  '92650000-0000-4000-8000-000000000101', 'ProgramUpgrade926', 'claim_lost',
  repeat('f', 64), repeat('e', 64), 2, 926502, '2026-07-15T09:01:00Z',
  'finalized', true, now(), now()
);
