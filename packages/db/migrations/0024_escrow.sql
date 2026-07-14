-- Called It on-chain escrow read model and durable workflow storage.
--
-- This migration is forward-only. Existing custodial markets, balances,
-- deposits, withdrawals, and settlement evidence remain untouched and
-- withdrawable. No row in a legacy financial table is copied or converted.

-- Every market is permanently assigned to exactly one accounting system.
alter table public.markets
  add column custody_mode text not null default 'legacy'
    check (custody_mode in ('legacy', 'escrow'));

create function public.escrow_keep_market_custody_mode_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.custody_mode <> old.custody_mode then
    raise exception 'market_custody_mode_immutable';
  end if;
  return new;
end;
$$;

create trigger markets_custody_mode_immutable
before update of custody_mode on public.markets
for each row execute function public.escrow_keep_market_custody_mode_immutable();

-- Group rollout controls select custody only for newly-created markets.
create table public.escrow_group_rollouts (
  group_id       bigint primary key references public.groups(id),
  custody_mode   text not null default 'legacy'
                 check (custody_mode in ('legacy', 'escrow')),
  cluster        text check (cluster in ('localnet', 'devnet', 'mainnet-beta')),
  genesis_hash   text,
  program_id     text,
  custody_version integer check (custody_version > 0),
  enabled_by     bigint references public.users(id),
  updated_at     timestamptz not null default now(),
  check (
    custody_mode = 'legacy'
    or (
      cluster is not null
      and genesis_hash is not null and genesis_hash <> ''
      and program_id is not null and program_id <> ''
      and custody_version is not null
    )
  )
);

-- Global chain identity prevents one instruction from being interpreted as
-- two different economic events across projection tables.
create table public.escrow_chain_event_identities (
  signature         text not null,
  instruction_index integer not null check (instruction_index >= 0),
  cluster           text not null check (cluster in ('localnet', 'devnet', 'mainnet-beta')),
  program_id        text not null check (program_id <> ''),
  event_kind        text not null check (event_kind in ('market', 'position', 'settlement', 'claim')),
  slot              bigint not null check (slot >= 0),
  commitment        text not null check (commitment in ('confirmed', 'finalized')),
  canonical         boolean not null default true,
  observed_at       timestamptz not null,
  finalized_at      timestamptz,
  orphaned_at       timestamptz,
  primary key (signature, instruction_index),
  check ((commitment = 'finalized') = (finalized_at is not null)),
  check (commitment <> 'finalized' or (canonical and orphaned_at is null)),
  check ((canonical and orphaned_at is null) or (not canonical and orphaned_at is not null))
);

create index escrow_chain_event_slot_idx
  on public.escrow_chain_event_identities (cluster, program_id, slot);

create table public.escrow_market_links (
  market_id                    uuid primary key references public.markets(id),
  custody_mode                 text not null default 'escrow' check (custody_mode = 'escrow'),
  custody_version              integer not null check (custody_version > 0),
  cluster                      text not null check (cluster in ('localnet', 'devnet', 'mainnet-beta')),
  genesis_hash                 text not null check (genesis_hash <> ''),
  program_id                   text not null check (program_id <> ''),
  market_pda                   text not null check (market_pda <> ''),
  vault_pda                    text not null check (vault_pda <> ''),
  asset                        text not null check (asset in ('sol', 'usdc')),
  mint_pubkey                  text,
  document_hash_hex            text not null check (document_hash_hex ~ '^[0-9A-Fa-f]{64}$'),
  initialize_signature         text not null,
  initialize_instruction_index integer not null check (initialize_instruction_index >= 0),
  initialize_slot              bigint not null check (initialize_slot >= 0),
  initialize_block_time        timestamptz,
  oracle_epoch                 numeric(20, 0) not null check (oracle_epoch >= 0),
  event_epoch                  numeric(20, 0) not null check (event_epoch >= 0),
  ratio_milli                  numeric(20, 0) not null check (ratio_milli > 0),
  chain_state                  text not null default 'open'
                               check (chain_state in ('open', 'frozen', 'settled', 'voided', 'closed')),
  commitment                   text not null check (commitment in ('confirmed', 'finalized')),
  canonical                    boolean not null default true,
  finalized_at                 timestamptz,
  orphaned_at                  timestamptz,
  projection_stale             boolean not null default false,
  created_at                   timestamptz not null,
  updated_at                   timestamptz not null,
  unique (cluster, program_id, market_pda),
  unique (initialize_signature, initialize_instruction_index),
  foreign key (initialize_signature, initialize_instruction_index)
    references public.escrow_chain_event_identities(signature, instruction_index),
  check (
    (asset = 'sol' and mint_pubkey is null)
    or (asset = 'usdc' and mint_pubkey is not null and mint_pubkey <> '')
  ),
  check ((commitment = 'finalized') = (finalized_at is not null)),
  check (commitment <> 'finalized' or (canonical and orphaned_at is null))
);

create function public.escrow_require_escrow_market_link()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_mode text;
  v_currency text;
begin
  select custody_mode, currency into v_mode, v_currency
  from public.markets
  where id = new.market_id;

  if v_mode is distinct from 'escrow' then
    raise exception 'escrow_link_requires_escrow_market';
  end if;
  if v_currency is distinct from new.asset then
    raise exception 'escrow_link_asset_mismatch';
  end if;
  return new;
end;
$$;

create trigger escrow_market_links_require_escrow_market
before insert or update on public.escrow_market_links
for each row execute function public.escrow_require_escrow_market_link();

-- Event rows are append-only observations. Canonical/finality flags may be
-- upgraded or rewound only through the indexer RPCs below.
create table public.escrow_position_events (
  signature         text not null,
  instruction_index integer not null check (instruction_index >= 0),
  market_id         uuid not null references public.escrow_market_links(market_id),
  program_id        text not null check (program_id <> ''),
  position_pda      text not null check (position_pda <> ''),
  owner_pubkey      text not null check (owner_pubkey <> ''),
  lot_nonce         numeric(20, 0) not null check (lot_nonce >= 0),
  event_kind        text not null check (event_kind in ('placed', 'activated', 'invalidated', 'refundable', 'claimed')),
  side              text not null check (side in ('back', 'doubt')),
  asset             text not null check (asset in ('sol', 'usdc')),
  amount_atomic     numeric(20, 0) not null check (amount_atomic > 0),
  event_epoch       numeric(20, 0) not null check (event_epoch >= 0),
  state             text not null check (state in ('pending', 'active', 'invalidated', 'refundable', 'claimed')),
  slot              bigint not null check (slot >= 0),
  block_time        timestamptz,
  commitment        text not null check (commitment in ('confirmed', 'finalized')),
  canonical         boolean not null default true,
  observed_at       timestamptz not null,
  finalized_at      timestamptz,
  orphaned_at       timestamptz,
  primary key (signature, instruction_index),
  foreign key (signature, instruction_index)
    references public.escrow_chain_event_identities(signature, instruction_index),
  check ((commitment = 'finalized') = (finalized_at is not null)),
  check (commitment <> 'finalized' or (canonical and orphaned_at is null))
);

create index escrow_position_events_market_slot_idx
  on public.escrow_position_events (market_id, slot);
create index escrow_position_events_owner_idx
  on public.escrow_position_events (market_id, owner_pubkey, lot_nonce);

-- Current lot projection, rebuilt from finalized events after any rewind.
create table public.escrow_position_lots (
  market_id                    uuid not null references public.escrow_market_links(market_id),
  owner_pubkey                 text not null check (owner_pubkey <> ''),
  lot_nonce                    numeric(20, 0) not null check (lot_nonce >= 0),
  position_pda                 text not null check (position_pda <> ''),
  side                         text not null check (side in ('back', 'doubt')),
  asset                        text not null check (asset in ('sol', 'usdc')),
  amount_atomic                numeric(20, 0) not null check (amount_atomic > 0),
  event_epoch                  numeric(20, 0) not null check (event_epoch >= 0),
  state                        text not null check (state in ('pending', 'active', 'invalidated', 'refundable', 'claimed')),
  placed_signature             text not null,
  placed_instruction_index     integer not null,
  latest_signature             text not null,
  latest_instruction_index     integer not null,
  latest_slot                  bigint not null check (latest_slot >= 0),
  commitment                   text not null check (commitment in ('confirmed', 'finalized')),
  canonical                    boolean not null default true,
  updated_at                   timestamptz not null,
  primary key (market_id, owner_pubkey, lot_nonce),
  foreign key (placed_signature, placed_instruction_index)
    references public.escrow_position_events(signature, instruction_index),
  foreign key (latest_signature, latest_instruction_index)
    references public.escrow_position_events(signature, instruction_index)
);

-- Direct position-account snapshots from Solana. These are not ledger sums.
create table public.escrow_position_accounts (
  market_id              uuid not null references public.escrow_market_links(market_id),
  owner_pubkey           text not null check (owner_pubkey <> ''),
  position_pda           text not null check (position_pda <> ''),
  side                   text not null check (side in ('back', 'doubt')),
  asset                  text not null check (asset in ('sol', 'usdc')),
  deposited_atomic       numeric(20, 0) not null check (deposited_atomic >= 0),
  pending_atomic         numeric(20, 0) not null check (pending_atomic >= 0),
  active_atomic          numeric(20, 0) not null check (active_atomic >= 0),
  refundable_atomic      numeric(20, 0) not null check (refundable_atomic >= 0),
  claimed_atomic         numeric(20, 0) not null check (claimed_atomic >= 0),
  next_lot_nonce         numeric(20, 0) not null check (next_lot_nonce >= 0),
  source_slot            bigint not null check (source_slot >= 0),
  commitment             text not null check (commitment in ('confirmed', 'finalized')),
  canonical              boolean not null default true,
  updated_at             timestamptz not null,
  primary key (market_id, owner_pubkey),
  unique (market_id, position_pda)
);

create table public.escrow_settlement_events (
  signature         text not null,
  instruction_index integer not null check (instruction_index >= 0),
  market_id         uuid not null references public.escrow_market_links(market_id),
  program_id        text not null check (program_id <> ''),
  outcome           text not null check (outcome in ('claim_won', 'claim_lost', 'void')),
  evidence_hash_hex text not null check (evidence_hash_hex ~ '^[0-9A-Fa-f]{64}$'),
  document_hash_hex text not null check (document_hash_hex ~ '^[0-9A-Fa-f]{64}$'),
  oracle_epoch      numeric(20, 0) not null check (oracle_epoch >= 0),
  slot              bigint not null check (slot >= 0),
  block_time        timestamptz,
  commitment        text not null check (commitment in ('confirmed', 'finalized')),
  canonical         boolean not null default true,
  observed_at       timestamptz not null,
  finalized_at      timestamptz,
  orphaned_at       timestamptz,
  primary key (signature, instruction_index),
  foreign key (signature, instruction_index)
    references public.escrow_chain_event_identities(signature, instruction_index),
  check ((commitment = 'finalized') = (finalized_at is not null)),
  check (commitment <> 'finalized' or (canonical and orphaned_at is null))
);

create unique index escrow_settlement_events_one_canonical_market
  on public.escrow_settlement_events (market_id) where canonical;

create table public.escrow_claim_events (
  signature          text not null,
  instruction_index  integer not null check (instruction_index >= 0),
  market_id          uuid not null references public.escrow_market_links(market_id),
  program_id         text not null check (program_id <> ''),
  owner_pubkey       text not null check (owner_pubkey <> ''),
  destination_pubkey text not null check (destination_pubkey <> ''),
  asset              text not null check (asset in ('sol', 'usdc')),
  amount_atomic      numeric(20, 0) not null check (amount_atomic > 0),
  claim_kind         text not null check (claim_kind in ('payout', 'refund')),
  slot               bigint not null check (slot >= 0),
  block_time         timestamptz,
  commitment         text not null check (commitment in ('confirmed', 'finalized')),
  canonical          boolean not null default true,
  observed_at        timestamptz not null,
  finalized_at       timestamptz,
  orphaned_at        timestamptz,
  primary key (signature, instruction_index),
  foreign key (signature, instruction_index)
    references public.escrow_chain_event_identities(signature, instruction_index),
  check ((commitment = 'finalized') = (finalized_at is not null)),
  check (commitment <> 'finalized' or (canonical and orphaned_at is null))
);

create index escrow_claim_events_market_slot_idx
  on public.escrow_claim_events (market_id, slot);
create unique index escrow_claim_events_one_canonical_owner
  on public.escrow_claim_events (market_id, owner_pubkey) where canonical;

create table public.escrow_chain_cursors (
  cluster                  text not null check (cluster in ('localnet', 'devnet', 'mainnet-beta')),
  genesis_hash             text not null check (genesis_hash <> ''),
  program_id               text not null check (program_id <> ''),
  last_confirmed_slot      bigint not null default 0 check (last_confirmed_slot >= 0),
  last_confirmed_signature text,
  last_finalized_slot      bigint not null default 0 check (last_finalized_slot >= 0),
  last_finalized_signature text,
  updated_at               timestamptz not null,
  primary key (cluster, program_id),
  check (last_finalized_slot <= last_confirmed_slot)
);

create table public.escrow_relayer_jobs (
  id                        uuid primary key default gen_random_uuid(),
  kind                      text not null check (kind in (
                              'market_initialization', 'freeze', 'unfreeze',
                              'position_activation', 'position_invalidation',
                              'settlement_submission', 'timeout_monitoring',
                              'auto_claim', 'account_close'
                            )),
  idempotency_key           text not null unique check (idempotency_key <> ''),
  state                     text not null default 'pending' check (state in (
                              'pending', 'leased', 'signed', 'submitted',
                              'unknown', 'retry_wait', 'complete', 'dead'
                            )),
  cluster                   text not null check (cluster in ('localnet', 'devnet', 'mainnet-beta')),
  program_id                text not null check (program_id <> ''),
  custody_mode              text not null default 'escrow' check (custody_mode = 'escrow'),
  custody_version           integer not null check (custody_version > 0),
  market_id                 uuid references public.markets(id),
  owner_pubkey              text,
  payload                   jsonb not null default '{}'::jsonb,
  attempts                  integer not null default 0 check (attempts >= 0),
  max_attempts              integer not null check (max_attempts > 0),
  lease_duration_ms         integer not null check (lease_duration_ms between 1000 and 600000),
  due_at                    timestamptz not null,
  lease_owner               text,
  lease_token               uuid,
  leased_at                 timestamptz,
  lease_expires_at          timestamptz,
  raw_transaction           text,
  expected_signature        text,
  transaction_message_hash_hex text check (
                              transaction_message_hash_hex is null
                              or transaction_message_hash_hex ~ '^[0-9A-Fa-f]{64}$'
                            ),
  last_valid_block_height   bigint check (last_valid_block_height >= 0),
  full_history_checked_at   timestamptz,
  submitted_at              timestamptz,
  confirmed_at              timestamptz,
  error_code                text,
  created_at                timestamptz not null,
  updated_at                timestamptz not null,
  completed_at              timestamptz,
  dead_at                   timestamptz,
  check (
    (raw_transaction is null and expected_signature is null and last_valid_block_height is null)
    or (raw_transaction is not null and expected_signature is not null and last_valid_block_height is not null)
  ),
  check (
    (lease_owner is null and lease_token is null and leased_at is null and lease_expires_at is null)
    or (lease_owner is not null and lease_token is not null and leased_at is not null and lease_expires_at is not null)
  )
);

create index escrow_relayer_jobs_ready_idx
  on public.escrow_relayer_jobs (state, due_at);
create index escrow_relayer_jobs_market_idx
  on public.escrow_relayer_jobs (market_id, kind);

-- Signing-session authorization is intentionally JSON-safe: every u64 is a
-- canonical decimal string so PostgREST/browser runtimes cannot round it.
-- The exact key set is frozen at schemaVersion 1 and cross-bound to the
-- normalized columns used by consume/replay checks.
create function public.escrow_signing_authorization_valid(
  p_payload jsonb,
  p_market_id uuid,
  p_side text,
  p_asset text,
  p_amount_atomic numeric,
  p_lot_nonce numeric,
  p_event_epoch numeric,
  p_document_hash_hex text,
  p_transaction_message_hash_hex text,
  p_expires_at timestamptz
) returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(
    jsonb_typeof(p_payload) = 'object'
    and pg_column_size(p_payload) <= 8192
    and p_payload ?& array[
      'schemaVersion', 'programId', 'relayerFeePayer', 'canonicalUsdcMint',
      'marketUuid', 'marketPda', 'marketDocumentHashHex', 'side', 'amount',
      'asset', 'expectedRatioMilli', 'expectedEventEpoch', 'expectedLotNonce',
      'expiresAt', 'genesisHash', 'recentBlockhash', 'lastValidBlockHeight',
      'messageHashHex'
    ]
    and p_payload - array[
      'schemaVersion', 'programId', 'relayerFeePayer', 'canonicalUsdcMint',
      'marketUuid', 'marketPda', 'marketDocumentHashHex', 'side', 'amount',
      'asset', 'expectedRatioMilli', 'expectedEventEpoch', 'expectedLotNonce',
      'expiresAt', 'genesisHash', 'recentBlockhash', 'lastValidBlockHeight',
      'messageHashHex'
    ] = '{}'::jsonb
    and p_payload -> 'schemaVersion' = '1'::jsonb
    and jsonb_typeof(p_payload -> 'programId') = 'string'
    and length(p_payload ->> 'programId') between 1 and 128
    and jsonb_typeof(p_payload -> 'relayerFeePayer') = 'string'
    and length(p_payload ->> 'relayerFeePayer') between 1 and 128
    and jsonb_typeof(p_payload -> 'canonicalUsdcMint') = 'string'
    and length(p_payload ->> 'canonicalUsdcMint') between 1 and 128
    and jsonb_typeof(p_payload -> 'marketPda') = 'string'
    and length(p_payload ->> 'marketPda') between 1 and 128
    and jsonb_typeof(p_payload -> 'genesisHash') = 'string'
    and length(p_payload ->> 'genesisHash') between 1 and 128
    and jsonb_typeof(p_payload -> 'recentBlockhash') = 'string'
    and length(p_payload ->> 'recentBlockhash') between 1 and 128
    and jsonb_typeof(p_payload -> 'marketUuid') = 'string'
    and p_payload ->> 'marketUuid' = p_market_id::text
    and jsonb_typeof(p_payload -> 'side') = 'string'
    and p_payload ->> 'side' = p_side
    and jsonb_typeof(p_payload -> 'asset') = 'string'
    and p_payload ->> 'asset' = p_asset
    and jsonb_typeof(p_payload -> 'amount') = 'string'
    and p_payload ->> 'amount' = p_amount_atomic::text
    and jsonb_typeof(p_payload -> 'expectedEventEpoch') = 'string'
    and p_payload ->> 'expectedEventEpoch' = p_event_epoch::text
    and jsonb_typeof(p_payload -> 'expectedLotNonce') = 'string'
    and p_payload ->> 'expectedLotNonce' = p_lot_nonce::text
    and jsonb_typeof(p_payload -> 'expectedRatioMilli') = 'string'
    and p_payload ->> 'expectedRatioMilli' ~ '^[1-9][0-9]{0,19}$'
    and jsonb_typeof(p_payload -> 'lastValidBlockHeight') = 'string'
    and p_payload ->> 'lastValidBlockHeight' ~ '^[1-9][0-9]{0,19}$'
    and jsonb_typeof(p_payload -> 'expiresAt') = 'string'
    and date_trunc('second', p_expires_at) = p_expires_at
    and p_payload ->> 'expiresAt' = extract(epoch from p_expires_at)::bigint::text
    and jsonb_typeof(p_payload -> 'marketDocumentHashHex') = 'string'
    and p_payload ->> 'marketDocumentHashHex' = lower(p_document_hash_hex)
    and jsonb_typeof(p_payload -> 'messageHashHex') = 'string'
    and p_payload ->> 'messageHashHex' = lower(p_transaction_message_hash_hex),
    false
  );
$$;

create table public.escrow_signing_sessions (
  token_hash                    bytea primary key check (octet_length(token_hash) = 32),
  user_id                       bigint not null references public.users(id),
  provider_user_id              text not null check (provider_user_id <> ''),
  provider_wallet_id            text not null check (provider_wallet_id <> ''),
  owner_pubkey                  text not null check (owner_pubkey <> ''),
  market_id                     uuid not null references public.escrow_market_links(market_id),
  side                          text not null check (side in ('back', 'doubt')),
  asset                         text not null check (asset in ('sol', 'usdc')),
  amount_atomic                 numeric(20, 0) not null check (amount_atomic > 0),
  lot_nonce                     numeric(20, 0) not null check (lot_nonce >= 0),
  event_epoch                   numeric(20, 0) not null check (event_epoch >= 0),
  document_hash_hex             text not null check (document_hash_hex ~ '^[0-9A-Fa-f]{64}$'),
  transaction_message_hash_hex  text not null check (transaction_message_hash_hex ~ '^[0-9A-Fa-f]{64}$'),
  raw_transaction_base64        text not null check (
                                  length(raw_transaction_base64) between 4 and 4096
                                  and length(raw_transaction_base64) % 4 = 0
                                  and raw_transaction_base64 ~ '^[A-Za-z0-9+/]+={0,2}$'
                                ),
  authorization_payload         jsonb not null,
  state                         text not null default 'pending'
                                check (state in ('pending', 'consumed', 'cancelled', 'expired')),
  transaction_signature         text,
  expires_at                    timestamptz not null,
  created_at                    timestamptz not null,
  consumed_at                   timestamptz,
  updated_at                    timestamptz not null,
  check (public.escrow_signing_authorization_valid(
    authorization_payload, market_id, side, asset, amount_atomic, lot_nonce,
    event_epoch, document_hash_hex, transaction_message_hash_hex, expires_at
  )),
  check ((state = 'consumed') = (consumed_at is not null and transaction_signature is not null))
);

create index escrow_signing_sessions_expiry_idx
  on public.escrow_signing_sessions (expires_at) where state = 'pending';

-- Latest reconciliation state plus immutable checks. Amounts are direct
-- snapshots from program accounts; they are never derived from legacy ledger
-- entries or by summing indexed events.
create table public.escrow_reconciliation_checks (
  market_id              uuid not null references public.escrow_market_links(market_id),
  checked_slot           bigint not null check (checked_slot >= 0),
  cluster                text not null check (cluster in ('localnet', 'devnet', 'mainnet-beta')),
  program_id             text not null check (program_id <> ''),
  vault_balance_atomic   numeric(20, 0) not null check (vault_balance_atomic >= 0),
  liability_atomic       numeric(20, 0) not null check (liability_atomic >= 0),
  drift_atomic           numeric(21, 0) not null,
  position_account_count integer not null check (position_account_count >= 0),
  status                 text not null check (status in ('in_sync', 'drift', 'unavailable')),
  details                jsonb not null default '{}'::jsonb,
  checked_at             timestamptz not null,
  primary key (market_id, checked_slot)
);

create table public.escrow_reconciliation_state (
  market_id              uuid primary key references public.escrow_market_links(market_id),
  checked_slot           bigint not null check (checked_slot >= 0),
  cluster                text not null check (cluster in ('localnet', 'devnet', 'mainnet-beta')),
  program_id             text not null check (program_id <> ''),
  vault_balance_atomic   numeric(20, 0) not null check (vault_balance_atomic >= 0),
  liability_atomic       numeric(20, 0) not null check (liability_atomic >= 0),
  drift_atomic           numeric(21, 0) not null,
  position_account_count integer not null check (position_account_count >= 0),
  status                 text not null check (status in ('in_sync', 'drift', 'unavailable')),
  checked_at             timestamptz not null
);

-- Legacy financial tables reject escrow market ids. User-global legacy
-- deposits and withdrawals remain operational because they carry no market id.
create function public.escrow_reject_legacy_financial_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.market_id is not null and exists (
    select 1 from public.markets m
    where m.id = new.market_id and m.custody_mode = 'escrow'
  ) then
    raise exception 'escrow_market_cannot_use_legacy_accounting';
  end if;
  return new;
end;
$$;

create trigger wager_ledger_entries_reject_escrow
before insert or update of market_id on public.wager_ledger_entries
for each row execute function public.escrow_reject_legacy_financial_write();

create trigger wager_pending_stake_intents_reject_escrow
before insert or update of market_id on public.wager_pending_stake_intents
for each row execute function public.escrow_reject_legacy_financial_write();

create trigger wager_settlements_applied_reject_escrow
before insert or update of market_id on public.wager_settlements_applied
for each row execute function public.escrow_reject_legacy_financial_write();

-- RLS: every identity-bearing or workflow table is service-role only.
alter table public.escrow_group_rollouts enable row level security;
alter table public.escrow_chain_event_identities enable row level security;
alter table public.escrow_market_links enable row level security;
alter table public.escrow_position_events enable row level security;
alter table public.escrow_position_lots enable row level security;
alter table public.escrow_position_accounts enable row level security;
alter table public.escrow_settlement_events enable row level security;
alter table public.escrow_claim_events enable row level security;
alter table public.escrow_chain_cursors enable row level security;
alter table public.escrow_relayer_jobs enable row level security;
alter table public.escrow_signing_sessions enable row level security;
alter table public.escrow_reconciliation_checks enable row level security;
alter table public.escrow_reconciliation_state enable row level security;

revoke all privileges on table
  public.escrow_group_rollouts,
  public.escrow_chain_event_identities,
  public.escrow_market_links,
  public.escrow_position_events,
  public.escrow_position_lots,
  public.escrow_position_accounts,
  public.escrow_settlement_events,
  public.escrow_claim_events,
  public.escrow_chain_cursors,
  public.escrow_relayer_jobs,
  public.escrow_signing_sessions,
  public.escrow_reconciliation_checks,
  public.escrow_reconciliation_state
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.escrow_group_rollouts,
  public.escrow_chain_event_identities,
  public.escrow_market_links,
  public.escrow_position_events,
  public.escrow_position_lots,
  public.escrow_position_accounts,
  public.escrow_settlement_events,
  public.escrow_claim_events,
  public.escrow_chain_cursors,
  public.escrow_relayer_jobs,
  public.escrow_signing_sessions,
  public.escrow_reconciliation_checks,
  public.escrow_reconciliation_state
to service_role;

-- Public views are finalized and aggregate-first. They deliberately exclude
-- owner pubkeys, destination pubkeys, provider ids, Telegram ids, and tokens.
create view public.public_escrow_receipts
with (security_barrier = true)
as
select
  ml.market_id,
  g.slug as group_slug,
  g.web_enabled,
  ml.cluster,
  ml.program_id,
  ml.market_pda,
  ml.vault_pda,
  ml.asset,
  ml.document_hash_hex,
  ml.initialize_signature,
  ml.initialize_slot,
  se.outcome,
  se.signature as settlement_signature,
  se.slot as settlement_slot,
  se.evidence_hash_hex,
  se.block_time as settled_at
from public.escrow_market_links ml
join public.markets m on m.id = ml.market_id
join public.groups g on g.id = m.group_id
left join public.escrow_settlement_events se
  on se.market_id = ml.market_id
 and se.canonical
 and se.commitment = 'finalized'
where g.web_enabled
  and ml.canonical
  and ml.commitment = 'finalized';

create view public.public_escrow_position_aggregates
with (security_barrier = true)
as
select
  lots.market_id,
  ml.cluster,
  lots.asset,
  lots.side,
  lots.state,
  count(*)::bigint as lot_count,
  sum(lots.amount_atomic)::numeric(20, 0) as amount_atomic
from public.escrow_position_lots lots
join public.escrow_market_links ml on ml.market_id = lots.market_id
join public.markets m on m.id = lots.market_id
join public.groups g on g.id = m.group_id
where g.web_enabled
  and lots.canonical
  and lots.commitment = 'finalized'
  and ml.canonical
  and ml.commitment = 'finalized'
group by lots.market_id, ml.cluster, lots.asset, lots.side, lots.state;

create view public.public_escrow_claim_transactions
with (security_barrier = true)
as
select
  ce.market_id,
  ml.cluster,
  ce.signature as claim_signature,
  ce.slot as claim_slot,
  ce.block_time as claimed_at,
  ce.asset,
  ce.claim_kind,
  count(*)::bigint as recipient_count,
  sum(ce.amount_atomic)::numeric(20, 0) as amount_atomic
from public.escrow_claim_events ce
join public.escrow_market_links ml on ml.market_id = ce.market_id
join public.markets m on m.id = ce.market_id
join public.groups g on g.id = m.group_id
where g.web_enabled
  and ce.canonical
  and ce.commitment = 'finalized'
  and ml.canonical
  and ml.commitment = 'finalized'
group by ce.market_id, ml.cluster, ce.signature, ce.slot, ce.block_time, ce.asset, ce.claim_kind;

revoke all privileges on table
  public.public_escrow_receipts,
  public.public_escrow_position_aggregates,
  public.public_escrow_claim_transactions
from public;
grant select on table
  public.public_escrow_receipts,
  public.public_escrow_position_aggregates,
  public.public_escrow_claim_transactions
to anon, authenticated, service_role;

-- ── Finalized, idempotent chain indexing ─────────────────────────────────

create function public.escrow_assert_chain_identity(
  p_signature text,
  p_instruction_index integer,
  p_cluster text,
  p_program_id text,
  p_event_kind text,
  p_slot bigint,
  p_commitment text,
  p_observed_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.escrow_chain_event_identities%rowtype;
  v_inserted boolean;
begin
  insert into public.escrow_chain_event_identities (
    signature, instruction_index, cluster, program_id, event_kind, slot,
    commitment, canonical, observed_at, finalized_at
  ) values (
    p_signature, p_instruction_index, p_cluster, p_program_id, p_event_kind, p_slot,
    p_commitment, true, p_observed_at,
    case when p_commitment = 'finalized' then p_observed_at else null end
  ) on conflict (signature, instruction_index) do nothing;
  v_inserted := found;

  if v_inserted then
    return true;
  end if;

  select * into v_existing
  from public.escrow_chain_event_identities
  where signature = p_signature and instruction_index = p_instruction_index
  for update;

  if v_existing.cluster is distinct from p_cluster
     or v_existing.program_id is distinct from p_program_id
     or v_existing.event_kind is distinct from p_event_kind
     or v_existing.slot is distinct from p_slot then
    raise exception 'escrow_chain_identity_conflict';
  end if;

  if v_existing.commitment = 'finalized' and p_commitment <> 'finalized' then
    return false;
  end if;

  update public.escrow_chain_event_identities
  set commitment = p_commitment,
      canonical = true,
      observed_at = least(observed_at, p_observed_at),
      finalized_at = case when p_commitment = 'finalized' then p_observed_at else null end,
      orphaned_at = null
  where signature = p_signature and instruction_index = p_instruction_index;
  return false;
end;
$$;

create function public.escrow_index_market_link(
  p_market_id uuid,
  p_custody_mode text,
  p_custody_version integer,
  p_cluster text,
  p_genesis_hash text,
  p_program_id text,
  p_market_pda text,
  p_vault_pda text,
  p_asset text,
  p_mint_pubkey text,
  p_document_hash_hex text,
  p_initialize_signature text,
  p_initialize_instruction_index integer,
  p_initialize_slot bigint,
  p_initialize_block_time timestamptz,
  p_oracle_epoch numeric,
  p_event_epoch numeric,
  p_ratio_milli numeric,
  p_commitment text,
  p_observed_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market record;
  v_existing public.escrow_market_links%rowtype;
  v_duplicate boolean;
  v_replacement boolean := false;
begin
  if p_custody_mode <> 'escrow' then
    raise exception 'escrow_custody_mode_required';
  end if;

  select custody_mode, currency into v_market
  from public.markets where id = p_market_id;
  if v_market is null or v_market.custody_mode <> 'escrow' then
    raise exception 'escrow_market_required';
  end if;
  if v_market.currency is distinct from p_asset then
    raise exception 'escrow_market_asset_mismatch';
  end if;

  perform public.escrow_assert_chain_identity(
    p_initialize_signature, p_initialize_instruction_index, p_cluster,
    p_program_id, 'market', p_initialize_slot, p_commitment, p_observed_at
  );

  select * into v_existing
  from public.escrow_market_links
  where market_id = p_market_id
  for update;
  if v_existing.market_id is not null then
    v_replacement := not v_existing.canonical
      and v_existing.commitment = 'confirmed'
      and (
        v_existing.initialize_signature is distinct from p_initialize_signature
        or v_existing.initialize_instruction_index is distinct from p_initialize_instruction_index
        or v_existing.initialize_slot is distinct from p_initialize_slot
      );
  end if;
  v_duplicate := v_existing.market_id is not null and not v_replacement;

  if v_duplicate and (
    v_existing.custody_mode is distinct from p_custody_mode
    or v_existing.custody_version is distinct from p_custody_version
    or v_existing.cluster is distinct from p_cluster
    or v_existing.genesis_hash is distinct from p_genesis_hash
    or v_existing.program_id is distinct from p_program_id
    or v_existing.market_pda is distinct from p_market_pda
    or v_existing.vault_pda is distinct from p_vault_pda
    or v_existing.asset is distinct from p_asset
    or v_existing.mint_pubkey is distinct from p_mint_pubkey
    or lower(v_existing.document_hash_hex) is distinct from lower(p_document_hash_hex)
    or (
      not v_replacement and (
        v_existing.initialize_signature is distinct from p_initialize_signature
        or v_existing.initialize_instruction_index is distinct from p_initialize_instruction_index
        or v_existing.initialize_slot is distinct from p_initialize_slot
      )
    )
    or v_existing.oracle_epoch is distinct from p_oracle_epoch
    or v_existing.event_epoch is distinct from p_event_epoch
    or v_existing.ratio_milli is distinct from p_ratio_milli
  ) then
    raise exception 'escrow_market_link_conflict';
  end if;

  insert into public.escrow_market_links (
    market_id, custody_mode, custody_version, cluster, genesis_hash, program_id,
    market_pda, vault_pda, asset, mint_pubkey, document_hash_hex,
    initialize_signature, initialize_instruction_index, initialize_slot,
    initialize_block_time, oracle_epoch, event_epoch, ratio_milli,
    commitment, canonical, finalized_at, created_at, updated_at
  ) values (
    p_market_id, p_custody_mode, p_custody_version, p_cluster, p_genesis_hash, p_program_id,
    p_market_pda, p_vault_pda, p_asset, p_mint_pubkey, lower(p_document_hash_hex),
    p_initialize_signature, p_initialize_instruction_index, p_initialize_slot,
    p_initialize_block_time, p_oracle_epoch, p_event_epoch, p_ratio_milli,
    p_commitment, true,
    case when p_commitment = 'finalized' then p_observed_at else null end,
    p_observed_at, p_observed_at
  ) on conflict (market_id) do update
  set initialize_signature = case
        when not public.escrow_market_links.canonical then excluded.initialize_signature
        else public.escrow_market_links.initialize_signature
      end,
      initialize_instruction_index = case
        when not public.escrow_market_links.canonical then excluded.initialize_instruction_index
        else public.escrow_market_links.initialize_instruction_index
      end,
      initialize_slot = case
        when not public.escrow_market_links.canonical then excluded.initialize_slot
        else public.escrow_market_links.initialize_slot
      end,
      initialize_block_time = case
        when not public.escrow_market_links.canonical then excluded.initialize_block_time
        else public.escrow_market_links.initialize_block_time
      end,
      commitment = case
        when public.escrow_market_links.commitment = 'finalized' then 'finalized'
        else excluded.commitment
      end,
      canonical = true,
      finalized_at = case
        when public.escrow_market_links.commitment = 'finalized' then public.escrow_market_links.finalized_at
        else excluded.finalized_at
      end,
      orphaned_at = null,
      updated_at = p_observed_at;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'finalized', p_commitment = 'finalized'
  );
end;
$$;

create function public.escrow_index_position_event(
  p_signature text,
  p_instruction_index integer,
  p_market_id uuid,
  p_program_id text,
  p_position_pda text,
  p_owner_pubkey text,
  p_lot_nonce numeric,
  p_event_kind text,
  p_side text,
  p_asset text,
  p_amount_atomic numeric,
  p_event_epoch numeric,
  p_state text,
  p_slot bigint,
  p_block_time timestamptz,
  p_commitment text,
  p_observed_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.escrow_market_links%rowtype;
  v_existing public.escrow_position_events%rowtype;
  v_lot public.escrow_position_lots%rowtype;
  v_duplicate boolean;
begin
  select * into v_link from public.escrow_market_links
  where market_id = p_market_id and canonical
  for update;
  if v_link.market_id is null
     or v_link.program_id is distinct from p_program_id
     or v_link.asset is distinct from p_asset
     or v_link.custody_mode <> 'escrow' then
    raise exception 'escrow_position_market_mismatch';
  end if;

  if (p_event_kind = 'activated' and p_state <> 'active')
     or (p_event_kind = 'invalidated' and p_state <> 'invalidated')
     or (p_event_kind = 'refundable' and p_state <> 'refundable')
     or (p_event_kind = 'claimed' and p_state <> 'claimed') then
    raise exception 'escrow_position_state_mismatch';
  end if;

  perform public.escrow_assert_chain_identity(
    p_signature, p_instruction_index, v_link.cluster, p_program_id,
    'position', p_slot, p_commitment, p_observed_at
  );

  select * into v_existing
  from public.escrow_position_events
  where signature = p_signature and instruction_index = p_instruction_index
  for update;
  v_duplicate := found;
  if v_duplicate and (
    v_existing.market_id is distinct from p_market_id
    or v_existing.program_id is distinct from p_program_id
    or v_existing.position_pda is distinct from p_position_pda
    or v_existing.owner_pubkey is distinct from p_owner_pubkey
    or v_existing.lot_nonce is distinct from p_lot_nonce
    or v_existing.event_kind is distinct from p_event_kind
    or v_existing.side is distinct from p_side
    or v_existing.asset is distinct from p_asset
    or v_existing.amount_atomic is distinct from p_amount_atomic
    or v_existing.event_epoch is distinct from p_event_epoch
    or v_existing.state is distinct from p_state
    or v_existing.slot is distinct from p_slot
  ) then
    raise exception 'escrow_position_event_conflict';
  end if;

  insert into public.escrow_position_events (
    signature, instruction_index, market_id, program_id, position_pda,
    owner_pubkey, lot_nonce, event_kind, side, asset, amount_atomic,
    event_epoch, state, slot, block_time, commitment, canonical,
    observed_at, finalized_at
  ) values (
    p_signature, p_instruction_index, p_market_id, p_program_id, p_position_pda,
    p_owner_pubkey, p_lot_nonce, p_event_kind, p_side, p_asset, p_amount_atomic,
    p_event_epoch, p_state, p_slot, p_block_time, p_commitment, true,
    p_observed_at, case when p_commitment = 'finalized' then p_observed_at else null end
  ) on conflict (signature, instruction_index) do update
  set commitment = case
        when public.escrow_position_events.commitment = 'finalized' then 'finalized'
        else excluded.commitment
      end,
      canonical = true,
      finalized_at = case
        when public.escrow_position_events.commitment = 'finalized' then public.escrow_position_events.finalized_at
        else excluded.finalized_at
      end,
      orphaned_at = null;

  select * into v_lot from public.escrow_position_lots
  where market_id = p_market_id and owner_pubkey = p_owner_pubkey and lot_nonce = p_lot_nonce
  for update;

  if p_event_kind = 'placed' then
    if v_lot.market_id is not null and (
      v_lot.position_pda is distinct from p_position_pda
      or v_lot.side is distinct from p_side
      or v_lot.asset is distinct from p_asset
      or v_lot.amount_atomic is distinct from p_amount_atomic
      or v_lot.event_epoch is distinct from p_event_epoch
      or v_lot.placed_signature is distinct from p_signature
      or v_lot.placed_instruction_index is distinct from p_instruction_index
    ) then
      raise exception 'escrow_position_lot_conflict';
    end if;

    insert into public.escrow_position_lots (
      market_id, owner_pubkey, lot_nonce, position_pda, side, asset,
      amount_atomic, event_epoch, state, placed_signature,
      placed_instruction_index, latest_signature, latest_instruction_index,
      latest_slot, commitment, canonical, updated_at
    ) values (
      p_market_id, p_owner_pubkey, p_lot_nonce, p_position_pda, p_side, p_asset,
      p_amount_atomic, p_event_epoch, p_state, p_signature,
      p_instruction_index, p_signature, p_instruction_index,
      p_slot, p_commitment, true, p_observed_at
    ) on conflict (market_id, owner_pubkey, lot_nonce) do update
    set commitment = case
          when public.escrow_position_lots.commitment = 'finalized' then 'finalized'
          else excluded.commitment
        end,
        canonical = true,
        updated_at = p_observed_at;
  else
    if v_lot.market_id is null then
      raise exception 'escrow_position_lot_missing';
    end if;
    update public.escrow_position_lots
    set state = p_state,
        latest_signature = p_signature,
        latest_instruction_index = p_instruction_index,
        latest_slot = p_slot,
        commitment = p_commitment,
        canonical = true,
        updated_at = p_observed_at
    where market_id = p_market_id and owner_pubkey = p_owner_pubkey and lot_nonce = p_lot_nonce;
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'finalized', p_commitment = 'finalized'
  );
end;
$$;

create function public.escrow_index_settlement_event(
  p_signature text,
  p_instruction_index integer,
  p_market_id uuid,
  p_program_id text,
  p_outcome text,
  p_evidence_hash_hex text,
  p_document_hash_hex text,
  p_oracle_epoch numeric,
  p_slot bigint,
  p_block_time timestamptz,
  p_commitment text,
  p_observed_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.escrow_market_links%rowtype;
  v_existing public.escrow_settlement_events%rowtype;
  v_duplicate boolean;
begin
  select * into v_link from public.escrow_market_links
  where market_id = p_market_id and canonical
  for update;
  if v_link.market_id is null
     or v_link.program_id is distinct from p_program_id
     or lower(v_link.document_hash_hex) is distinct from lower(p_document_hash_hex)
     or v_link.oracle_epoch is distinct from p_oracle_epoch
     or v_link.custody_mode <> 'escrow' then
    raise exception 'escrow_settlement_market_mismatch';
  end if;

  select * into v_existing
  from public.escrow_settlement_events
  where signature = p_signature and instruction_index = p_instruction_index
  for update;
  v_duplicate := found;
  if v_duplicate and (
    v_existing.market_id is distinct from p_market_id
    or v_existing.program_id is distinct from p_program_id
    or v_existing.outcome is distinct from p_outcome
    or lower(v_existing.evidence_hash_hex) is distinct from lower(p_evidence_hash_hex)
    or lower(v_existing.document_hash_hex) is distinct from lower(p_document_hash_hex)
    or v_existing.oracle_epoch is distinct from p_oracle_epoch
    or v_existing.slot is distinct from p_slot
  ) then
    raise exception 'escrow_settlement_event_conflict';
  end if;

  if not v_duplicate and exists (
    select 1 from public.escrow_settlement_events
    where market_id = p_market_id and canonical and commitment = 'finalized'
  ) then
    raise exception 'escrow_settlement_already_finalized';
  end if;

  if not v_duplicate then
    update public.escrow_settlement_events
    set canonical = false, orphaned_at = p_observed_at
    where market_id = p_market_id and canonical and commitment = 'confirmed';
    update public.escrow_chain_event_identities ids
    set canonical = false, orphaned_at = p_observed_at
    from public.escrow_settlement_events se
    where se.market_id = p_market_id
      and not se.canonical
      and se.signature = ids.signature
      and se.instruction_index = ids.instruction_index
      and ids.commitment = 'confirmed';
  end if;

  perform public.escrow_assert_chain_identity(
    p_signature, p_instruction_index, v_link.cluster, p_program_id,
    'settlement', p_slot, p_commitment, p_observed_at
  );

  insert into public.escrow_settlement_events (
    signature, instruction_index, market_id, program_id, outcome,
    evidence_hash_hex, document_hash_hex, oracle_epoch, slot, block_time,
    commitment, canonical, observed_at, finalized_at
  ) values (
    p_signature, p_instruction_index, p_market_id, p_program_id, p_outcome,
    lower(p_evidence_hash_hex), lower(p_document_hash_hex), p_oracle_epoch, p_slot, p_block_time,
    p_commitment, true, p_observed_at,
    case when p_commitment = 'finalized' then p_observed_at else null end
  ) on conflict (signature, instruction_index) do update
  set commitment = case
        when public.escrow_settlement_events.commitment = 'finalized' then 'finalized'
        else excluded.commitment
      end,
      canonical = true,
      finalized_at = case
        when public.escrow_settlement_events.commitment = 'finalized' then public.escrow_settlement_events.finalized_at
        else excluded.finalized_at
      end,
      orphaned_at = null;

  update public.escrow_market_links
  set chain_state = case when p_outcome = 'void' then 'voided' else 'settled' end,
      projection_stale = false,
      updated_at = p_observed_at
  where market_id = p_market_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'finalized', p_commitment = 'finalized'
  );
end;
$$;

create function public.escrow_index_claim_event(
  p_signature text,
  p_instruction_index integer,
  p_market_id uuid,
  p_program_id text,
  p_owner_pubkey text,
  p_destination_pubkey text,
  p_asset text,
  p_amount_atomic numeric,
  p_claim_kind text,
  p_slot bigint,
  p_block_time timestamptz,
  p_commitment text,
  p_observed_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.escrow_market_links%rowtype;
  v_existing public.escrow_claim_events%rowtype;
  v_duplicate boolean;
begin
  select * into v_link from public.escrow_market_links
  where market_id = p_market_id and canonical
  for update;
  if v_link.market_id is null
     or v_link.program_id is distinct from p_program_id
     or v_link.asset is distinct from p_asset
     or v_link.custody_mode <> 'escrow' then
    raise exception 'escrow_claim_market_mismatch';
  end if;

  select * into v_existing
  from public.escrow_claim_events
  where signature = p_signature and instruction_index = p_instruction_index
  for update;
  v_duplicate := found;
  if v_duplicate and (
    v_existing.market_id is distinct from p_market_id
    or v_existing.program_id is distinct from p_program_id
    or v_existing.owner_pubkey is distinct from p_owner_pubkey
    or v_existing.destination_pubkey is distinct from p_destination_pubkey
    or v_existing.asset is distinct from p_asset
    or v_existing.amount_atomic is distinct from p_amount_atomic
    or v_existing.claim_kind is distinct from p_claim_kind
    or v_existing.slot is distinct from p_slot
  ) then
    raise exception 'escrow_claim_event_conflict';
  end if;

  if not v_duplicate and exists (
    select 1 from public.escrow_claim_events
    where market_id = p_market_id and owner_pubkey = p_owner_pubkey
      and canonical and commitment = 'finalized'
  ) then
    raise exception 'escrow_claim_already_finalized';
  end if;

  if not v_duplicate then
    update public.escrow_claim_events
    set canonical = false, orphaned_at = p_observed_at
    where market_id = p_market_id and owner_pubkey = p_owner_pubkey
      and canonical and commitment = 'confirmed';
    update public.escrow_chain_event_identities ids
    set canonical = false, orphaned_at = p_observed_at
    from public.escrow_claim_events ce
    where ce.market_id = p_market_id
      and ce.owner_pubkey = p_owner_pubkey
      and not ce.canonical
      and ce.signature = ids.signature
      and ce.instruction_index = ids.instruction_index
      and ids.commitment = 'confirmed';
  end if;

  perform public.escrow_assert_chain_identity(
    p_signature, p_instruction_index, v_link.cluster, p_program_id,
    'claim', p_slot, p_commitment, p_observed_at
  );

  insert into public.escrow_claim_events (
    signature, instruction_index, market_id, program_id, owner_pubkey,
    destination_pubkey, asset, amount_atomic, claim_kind, slot, block_time,
    commitment, canonical, observed_at, finalized_at
  ) values (
    p_signature, p_instruction_index, p_market_id, p_program_id, p_owner_pubkey,
    p_destination_pubkey, p_asset, p_amount_atomic, p_claim_kind, p_slot, p_block_time,
    p_commitment, true, p_observed_at,
    case when p_commitment = 'finalized' then p_observed_at else null end
  ) on conflict (signature, instruction_index) do update
  set commitment = case
        when public.escrow_claim_events.commitment = 'finalized' then 'finalized'
        else excluded.commitment
      end,
      canonical = true,
      finalized_at = case
        when public.escrow_claim_events.commitment = 'finalized' then public.escrow_claim_events.finalized_at
        else excluded.finalized_at
      end,
      orphaned_at = null;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'finalized', p_commitment = 'finalized'
  );
end;
$$;

create function public.escrow_advance_chain_cursor(
  p_cluster text,
  p_genesis_hash text,
  p_program_id text,
  p_commitment text,
  p_slot bigint,
  p_signature text,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cursor public.escrow_chain_cursors%rowtype;
  v_duplicate boolean := false;
  v_inserted boolean;
begin
  insert into public.escrow_chain_cursors (
    cluster, genesis_hash, program_id,
    last_confirmed_slot, last_confirmed_signature,
    last_finalized_slot, last_finalized_signature, updated_at
  ) values (
    p_cluster, p_genesis_hash, p_program_id,
    p_slot, p_signature,
    case when p_commitment = 'finalized' then p_slot else 0 end,
    case when p_commitment = 'finalized' then p_signature else null end,
    p_now
  ) on conflict (cluster, program_id) do nothing;
  v_inserted := found;

  select * into v_cursor from public.escrow_chain_cursors
  where cluster = p_cluster and program_id = p_program_id
  for update;

  if v_cursor.genesis_hash is distinct from p_genesis_hash then
    raise exception 'escrow_chain_genesis_mismatch';
  end if;

  if v_inserted then
    return jsonb_build_object(
      'ok', true,
      'duplicate', false,
      'finalized', p_commitment = 'finalized'
    );
  end if;

  if p_commitment = 'confirmed' then
    if p_slot < v_cursor.last_confirmed_slot
       or (p_slot = v_cursor.last_confirmed_slot and v_cursor.last_confirmed_signature = p_signature) then
      v_duplicate := true;
    else
      update public.escrow_chain_cursors
      set last_confirmed_slot = p_slot,
          last_confirmed_signature = p_signature,
          updated_at = p_now
      where cluster = p_cluster and program_id = p_program_id;
    end if;
  elsif p_commitment = 'finalized' then
    if p_slot < v_cursor.last_finalized_slot
       or (p_slot = v_cursor.last_finalized_slot and v_cursor.last_finalized_signature = p_signature) then
      v_duplicate := true;
    else
      update public.escrow_chain_cursors
      set last_finalized_slot = p_slot,
          last_finalized_signature = p_signature,
          last_confirmed_slot = greatest(last_confirmed_slot, p_slot),
          last_confirmed_signature = case
            when last_confirmed_slot <= p_slot then p_signature
            else last_confirmed_signature
          end,
          updated_at = p_now
      where cluster = p_cluster and program_id = p_program_id;
    end if;
  else
    raise exception 'escrow_chain_commitment_invalid';
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'finalized', p_commitment = 'finalized'
  );
end;
$$;

create function public.escrow_rewind_confirmed_chain(
  p_cluster text,
  p_program_id text,
  p_rewind_slot bigint,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cursor public.escrow_chain_cursors%rowtype;
  v_count integer := 0;
  v_changed integer;
begin
  select * into v_cursor from public.escrow_chain_cursors
  where cluster = p_cluster and program_id = p_program_id
  for update;
  if v_cursor.program_id is null then
    raise exception 'escrow_chain_cursor_missing';
  end if;
  if p_rewind_slot < v_cursor.last_finalized_slot then
    raise exception 'escrow_rewind_crosses_finalized_slot';
  end if;
  if p_rewind_slot > v_cursor.last_confirmed_slot then
    raise exception 'escrow_rewind_ahead_of_cursor';
  end if;

  update public.escrow_market_links
  set canonical = false,
      orphaned_at = p_now,
      projection_stale = true,
      updated_at = p_now
  where cluster = p_cluster and program_id = p_program_id
    and commitment = 'confirmed' and initialize_slot > p_rewind_slot and canonical;
  get diagnostics v_changed = row_count;
  v_count := v_count + v_changed;

  update public.escrow_position_events pe
  set canonical = false, orphaned_at = p_now
  from public.escrow_market_links ml
  where pe.market_id = ml.market_id
    and ml.cluster = p_cluster and pe.program_id = p_program_id
    and pe.commitment = 'confirmed' and pe.slot > p_rewind_slot and pe.canonical;
  get diagnostics v_changed = row_count;
  v_count := v_count + v_changed;

  update public.escrow_settlement_events se
  set canonical = false, orphaned_at = p_now
  from public.escrow_market_links ml
  where se.market_id = ml.market_id
    and ml.cluster = p_cluster and se.program_id = p_program_id
    and se.commitment = 'confirmed' and se.slot > p_rewind_slot and se.canonical;
  get diagnostics v_changed = row_count;
  v_count := v_count + v_changed;

  update public.escrow_claim_events ce
  set canonical = false, orphaned_at = p_now
  from public.escrow_market_links ml
  where ce.market_id = ml.market_id
    and ml.cluster = p_cluster and ce.program_id = p_program_id
    and ce.commitment = 'confirmed' and ce.slot > p_rewind_slot and ce.canonical;
  get diagnostics v_changed = row_count;
  v_count := v_count + v_changed;

  update public.escrow_position_lots lots
  set canonical = false, updated_at = p_now
  from public.escrow_market_links ml
  where lots.market_id = ml.market_id
    and ml.cluster = p_cluster and ml.program_id = p_program_id
    and lots.commitment = 'confirmed' and lots.latest_slot > p_rewind_slot and lots.canonical;

  update public.escrow_position_accounts accounts
  set canonical = false, updated_at = p_now
  from public.escrow_market_links ml
  where accounts.market_id = ml.market_id
    and ml.cluster = p_cluster and ml.program_id = p_program_id
    and accounts.commitment = 'confirmed' and accounts.source_slot > p_rewind_slot and accounts.canonical;

  update public.escrow_chain_event_identities
  set canonical = false, orphaned_at = p_now
  where cluster = p_cluster and program_id = p_program_id
    and commitment = 'confirmed' and slot > p_rewind_slot and canonical;

  update public.escrow_market_links ml
  set projection_stale = true, updated_at = p_now
  where ml.cluster = p_cluster and ml.program_id = p_program_id
    and exists (
      select 1 from public.escrow_settlement_events se
      where se.market_id = ml.market_id and not se.canonical and se.orphaned_at = p_now
      union all
      select 1 from public.escrow_claim_events ce
      where ce.market_id = ml.market_id and not ce.canonical and ce.orphaned_at = p_now
      union all
      select 1 from public.escrow_position_events pe
      where pe.market_id = ml.market_id and not pe.canonical and pe.orphaned_at = p_now
    );

  update public.escrow_chain_cursors
  set last_confirmed_slot = p_rewind_slot,
      last_confirmed_signature = case
        when p_rewind_slot = last_finalized_slot then last_finalized_signature
        else null
      end,
      updated_at = p_now
  where cluster = p_cluster and program_id = p_program_id;

  return jsonb_build_object(
    'ok', true,
    'orphaned_events', v_count,
    'rewind_slot', p_rewind_slot::text
  );
end;
$$;

create function public.escrow_record_reconciliation(
  p_market_id uuid,
  p_cluster text,
  p_program_id text,
  p_checked_slot bigint,
  p_vault_balance_atomic numeric,
  p_liability_atomic numeric,
  p_position_account_count integer,
  p_status text,
  p_details jsonb,
  p_checked_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.escrow_market_links%rowtype;
  v_duplicate boolean;
  v_drift numeric(21, 0);
begin
  select * into v_link from public.escrow_market_links
  where market_id = p_market_id
  for update;
  if v_link.market_id is null
     or v_link.cluster is distinct from p_cluster
     or v_link.program_id is distinct from p_program_id
     or v_link.custody_mode <> 'escrow' then
    raise exception 'escrow_reconciliation_market_mismatch';
  end if;
  if p_status = 'in_sync' and p_vault_balance_atomic <> p_liability_atomic then
    raise exception 'escrow_reconciliation_false_sync';
  end if;
  if p_status = 'drift' and p_vault_balance_atomic = p_liability_atomic then
    raise exception 'escrow_reconciliation_false_drift';
  end if;

  v_drift := p_vault_balance_atomic - p_liability_atomic;
  select exists (
    select 1 from public.escrow_reconciliation_checks
    where market_id = p_market_id and checked_slot = p_checked_slot
  ) into v_duplicate;

  insert into public.escrow_reconciliation_checks (
    market_id, checked_slot, cluster, program_id, vault_balance_atomic,
    liability_atomic, drift_atomic, position_account_count, status, details, checked_at
  ) values (
    p_market_id, p_checked_slot, p_cluster, p_program_id, p_vault_balance_atomic,
    p_liability_atomic, v_drift, p_position_account_count, p_status,
    coalesce(p_details, '{}'::jsonb), p_checked_at
  ) on conflict (market_id, checked_slot) do update
  set vault_balance_atomic = excluded.vault_balance_atomic,
      liability_atomic = excluded.liability_atomic,
      drift_atomic = excluded.drift_atomic,
      position_account_count = excluded.position_account_count,
      status = excluded.status,
      details = excluded.details,
      checked_at = excluded.checked_at
  where public.escrow_reconciliation_checks.cluster = excluded.cluster
    and public.escrow_reconciliation_checks.program_id = excluded.program_id;

  insert into public.escrow_reconciliation_state (
    market_id, checked_slot, cluster, program_id, vault_balance_atomic,
    liability_atomic, drift_atomic, position_account_count, status, checked_at
  ) values (
    p_market_id, p_checked_slot, p_cluster, p_program_id, p_vault_balance_atomic,
    p_liability_atomic, v_drift, p_position_account_count, p_status, p_checked_at
  ) on conflict (market_id) do update
  set checked_slot = excluded.checked_slot,
      cluster = excluded.cluster,
      program_id = excluded.program_id,
      vault_balance_atomic = excluded.vault_balance_atomic,
      liability_atomic = excluded.liability_atomic,
      drift_atomic = excluded.drift_atomic,
      position_account_count = excluded.position_account_count,
      status = excluded.status,
      checked_at = excluded.checked_at
  where excluded.checked_slot >= public.escrow_reconciliation_state.checked_slot;

  update public.escrow_market_links
  set projection_stale = p_status <> 'in_sync', updated_at = p_checked_at
  where market_id = p_market_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'finalized', true
  );
end;
$$;

-- ── Single-use, fully-bound Privy signing sessions ───────────────────────

create function public.escrow_decode_sha256_hex(p_hex text)
returns bytea
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_hex is null or p_hex !~ '^[0-9A-Fa-f]{64}$' then
    return null;
  end if;
  return decode(p_hex, 'hex');
exception when others then
  return null;
end;
$$;

create function public.escrow_create_signing_session(
  p_token_hash_hex text,
  p_user_id bigint,
  p_provider_user_id text,
  p_provider_wallet_id text,
  p_owner_pubkey text,
  p_market_id uuid,
  p_side text,
  p_asset text,
  p_amount_atomic numeric,
  p_lot_nonce numeric,
  p_event_epoch numeric,
  p_document_hash_hex text,
  p_transaction_message_hash_hex text,
  p_raw_transaction_base64 text,
  p_authorization jsonb,
  p_expires_at timestamptz,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token_hash bytea := public.escrow_decode_sha256_hex(p_token_hash_hex);
  v_link public.escrow_market_links%rowtype;
  v_existing public.escrow_signing_sessions%rowtype;
begin
  if v_token_hash is null or p_now is null or p_expires_at is null
     or p_expires_at <= p_now or p_expires_at > p_now + interval '15 minutes'
     or p_side not in ('back', 'doubt') or p_asset not in ('sol', 'usdc')
     or p_amount_atomic is null or p_amount_atomic <= 0
     or p_lot_nonce is null or p_lot_nonce < 0
     or p_event_epoch is null or p_event_epoch < 0
     or p_raw_transaction_base64 is null
     or length(p_raw_transaction_base64) not between 4 and 4096
     or length(p_raw_transaction_base64) % 4 <> 0
     or p_raw_transaction_base64 !~ '^[A-Za-z0-9+/]+={0,2}$'
     or not public.escrow_signing_authorization_valid(
       p_authorization, p_market_id, p_side, p_asset, p_amount_atomic,
       p_lot_nonce, p_event_epoch, p_document_hash_hex,
       p_transaction_message_hash_hex, p_expires_at
     ) then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select * into v_link from public.escrow_market_links
  where market_id = p_market_id and canonical
    and chain_state in ('open', 'frozen')
  for share;
  if v_link.market_id is null
     or v_link.asset is distinct from p_asset
     or v_link.event_epoch is distinct from p_event_epoch
     or lower(v_link.document_hash_hex) is distinct from lower(p_document_hash_hex)
     or v_link.custody_mode <> 'escrow' then
    return jsonb_build_object('ok', false, 'code', 'binding_mismatch');
  end if;

  if not exists (
    select 1 from public.wager_wallet_links wallet
    where wallet.user_id = p_user_id
      and wallet.wallet_provider = 'privy'
      and wallet.provider_user_id = p_provider_user_id
      and wallet.provider_wallet_id = p_provider_wallet_id
      and wallet.pubkey = p_owner_pubkey
      and (
        (v_link.cluster = 'localnet' and wallet.solana_network = 'devnet')
        or wallet.solana_network = v_link.cluster
      )
  ) then
    return jsonb_build_object('ok', false, 'code', 'binding_mismatch');
  end if;

  select * into v_existing from public.escrow_signing_sessions
  where token_hash = v_token_hash
  for update;
  if v_existing.token_hash is not null then
    if v_existing.user_id = p_user_id
       and v_existing.provider_user_id = p_provider_user_id
       and v_existing.provider_wallet_id = p_provider_wallet_id
       and v_existing.owner_pubkey = p_owner_pubkey
       and v_existing.market_id = p_market_id
       and v_existing.side = p_side
       and v_existing.asset = p_asset
       and v_existing.amount_atomic = p_amount_atomic
       and v_existing.lot_nonce = p_lot_nonce
       and v_existing.event_epoch = p_event_epoch
       and lower(v_existing.document_hash_hex) = lower(p_document_hash_hex)
       and lower(v_existing.transaction_message_hash_hex) = lower(p_transaction_message_hash_hex)
       and v_existing.raw_transaction_base64 = p_raw_transaction_base64
       and v_existing.authorization_payload = p_authorization
       and v_existing.expires_at = p_expires_at then
      return jsonb_build_object('ok', true, 'created', false);
    end if;
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  insert into public.escrow_signing_sessions (
    token_hash, user_id, provider_user_id, provider_wallet_id, owner_pubkey,
    market_id, side, asset, amount_atomic, lot_nonce, event_epoch,
    document_hash_hex, transaction_message_hash_hex, raw_transaction_base64,
    authorization_payload, expires_at,
    created_at, updated_at
  ) values (
    v_token_hash, p_user_id, p_provider_user_id, p_provider_wallet_id, p_owner_pubkey,
    p_market_id, p_side, p_asset, p_amount_atomic, p_lot_nonce, p_event_epoch,
    lower(p_document_hash_hex), lower(p_transaction_message_hash_hex),
    p_raw_transaction_base64, p_authorization, p_expires_at,
    p_now, p_now
  );

  return jsonb_build_object('ok', true, 'created', true);
end;
$$;

create function public.escrow_get_signing_session(
  p_token_hash_hex text,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token_hash bytea := public.escrow_decode_sha256_hex(p_token_hash_hex);
  v_session public.escrow_signing_sessions%rowtype;
begin
  if v_token_hash is null or p_now is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select * into v_session from public.escrow_signing_sessions
  where token_hash = v_token_hash
  for update;
  if v_session.token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'session_not_found');
  end if;

  if v_session.state = 'pending' and v_session.expires_at <= p_now then
    update public.escrow_signing_sessions
    set state = 'expired', updated_at = p_now
    where token_hash = v_token_hash;
    return jsonb_build_object('ok', false, 'code', 'session_expired');
  end if;
  if v_session.state = 'expired' then
    return jsonb_build_object('ok', false, 'code', 'session_expired');
  end if;
  if v_session.state = 'cancelled' then
    return jsonb_build_object('ok', false, 'code', 'session_consumed');
  end if;
  if v_session.state not in ('pending', 'consumed') then
    return jsonb_build_object('ok', false, 'code', 'session_consumed');
  end if;

  return jsonb_build_object(
    'ok', true,
    'state', v_session.state,
    'user_id', v_session.user_id,
    'provider_user_id', v_session.provider_user_id,
    'provider_wallet_id', v_session.provider_wallet_id,
    'owner_pubkey', v_session.owner_pubkey,
    'market_id', v_session.market_id,
    'side', v_session.side,
    'asset', v_session.asset,
    'amount_atomic', v_session.amount_atomic::text,
    'lot_nonce', v_session.lot_nonce::text,
    'event_epoch', v_session.event_epoch::text,
    'document_hash_hex', v_session.document_hash_hex,
    'transaction_message_hash_hex', v_session.transaction_message_hash_hex,
    'raw_transaction_base64', v_session.raw_transaction_base64,
    'authorization', v_session.authorization_payload,
    'transaction_signature', v_session.transaction_signature,
    'expires_at', v_session.expires_at
  );
end;
$$;

create function public.escrow_consume_signing_session(
  p_token_hash_hex text,
  p_user_id bigint,
  p_provider_user_id text,
  p_provider_wallet_id text,
  p_owner_pubkey text,
  p_market_id uuid,
  p_transaction_message_hash_hex text,
  p_transaction_signature text,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token_hash bytea := public.escrow_decode_sha256_hex(p_token_hash_hex);
  v_session public.escrow_signing_sessions%rowtype;
begin
  if v_token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select * into v_session from public.escrow_signing_sessions
  where token_hash = v_token_hash
  for update;
  if v_session.token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'session_not_found');
  end if;

  if v_session.user_id <> p_user_id
     or v_session.provider_user_id <> p_provider_user_id
     or v_session.provider_wallet_id <> p_provider_wallet_id
     or v_session.owner_pubkey <> p_owner_pubkey
     or v_session.market_id <> p_market_id
     or lower(v_session.transaction_message_hash_hex) <> lower(p_transaction_message_hash_hex) then
    return jsonb_build_object('ok', false, 'code', 'binding_mismatch');
  end if;

  if v_session.state = 'consumed' then
    if v_session.transaction_signature = p_transaction_signature then
      return jsonb_build_object('ok', true, 'duplicate', true, 'state', 'consumed');
    end if;
    return jsonb_build_object('ok', false, 'code', 'session_consumed');
  end if;
  if v_session.state <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'session_consumed');
  end if;
  if v_session.expires_at <= p_now then
    update public.escrow_signing_sessions
    set state = 'expired', updated_at = p_now
    where token_hash = v_token_hash;
    return jsonb_build_object('ok', false, 'code', 'session_expired');
  end if;

  update public.escrow_signing_sessions
  set state = 'consumed',
      transaction_signature = p_transaction_signature,
      consumed_at = p_now,
      updated_at = p_now
  where token_hash = v_token_hash;

  return jsonb_build_object('ok', true, 'duplicate', false, 'state', 'consumed');
end;
$$;

-- ── Durable relayer outbox ───────────────────────────────────────────────

create function public.escrow_validate_relayer_job_custody()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_mode text;
  v_link public.escrow_market_links%rowtype;
  v_rollout public.escrow_group_rollouts%rowtype;
begin
  if new.custody_mode <> 'escrow' then
    raise exception 'escrow_relayer_custody_mode_required';
  end if;
  if new.market_id is null then
    return new;
  end if;

  select custody_mode into v_mode from public.markets where id = new.market_id;
  if v_mode is distinct from 'escrow' then
    raise exception 'escrow_relayer_market_mode_mismatch';
  end if;

  select * into v_link from public.escrow_market_links where market_id = new.market_id;
  if v_link.market_id is null then
    if new.kind <> 'market_initialization' then
      raise exception 'escrow_relayer_market_link_missing';
    end if;
    select rollout.* into v_rollout
    from public.markets market
    join public.escrow_group_rollouts rollout on rollout.group_id = market.group_id
    where market.id = new.market_id;
    if v_rollout.group_id is null
       or v_rollout.custody_mode <> 'escrow'
       or v_rollout.cluster <> new.cluster
       or v_rollout.program_id <> new.program_id
       or v_rollout.custody_version <> new.custody_version then
      raise exception 'escrow_relayer_group_rollout_mismatch';
    end if;
    return new;
  end if;

  if v_link.custody_mode <> new.custody_mode
     or v_link.custody_version <> new.custody_version
     or v_link.cluster <> new.cluster
     or v_link.program_id <> new.program_id then
    raise exception 'escrow_relayer_market_link_mismatch';
  end if;
  return new;
end;
$$;

create trigger escrow_relayer_jobs_validate_custody
before insert or update of custody_mode, custody_version, cluster, program_id, market_id, kind
on public.escrow_relayer_jobs
for each row execute function public.escrow_validate_relayer_job_custody();

create function public.escrow_relayer_enqueue(
  p_kind text,
  p_idempotency_key text,
  p_cluster text,
  p_program_id text,
  p_custody_mode text,
  p_custody_version integer,
  p_market_id uuid,
  p_owner_pubkey text,
  p_payload jsonb,
  p_due_at timestamptz,
  p_max_attempts integer,
  p_lease_ms integer,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.escrow_relayer_jobs%rowtype;
  v_job_id uuid;
begin
  if p_custody_mode <> 'escrow'
     or p_custody_version <= 0
     or p_max_attempts <= 0
     or p_lease_ms < 1000 or p_lease_ms > 600000 then
    raise exception 'escrow_relayer_queue_policy_invalid';
  end if;

  select * into v_existing from public.escrow_relayer_jobs
  where idempotency_key = p_idempotency_key
  for update;
  if v_existing.id is not null then
    if v_existing.kind is distinct from p_kind
       or v_existing.cluster is distinct from p_cluster
       or v_existing.program_id is distinct from p_program_id
       or v_existing.custody_mode is distinct from p_custody_mode
       or v_existing.custody_version is distinct from p_custody_version
       or v_existing.market_id is distinct from p_market_id
       or v_existing.owner_pubkey is distinct from p_owner_pubkey
       or v_existing.payload is distinct from coalesce(p_payload, '{}'::jsonb) then
      raise exception 'escrow_relayer_idempotency_conflict';
    end if;
    return jsonb_build_object('ok', true, 'created', false, 'job_id', v_existing.id);
  end if;

  insert into public.escrow_relayer_jobs (
    kind, idempotency_key, cluster, program_id, custody_mode, custody_version,
    market_id, owner_pubkey, payload, max_attempts, lease_duration_ms,
    due_at, created_at, updated_at
  ) values (
    p_kind, p_idempotency_key, p_cluster, p_program_id, p_custody_mode, p_custody_version,
    p_market_id, p_owner_pubkey, coalesce(p_payload, '{}'::jsonb), p_max_attempts, p_lease_ms,
    p_due_at, p_now, p_now
  ) returning id into v_job_id;

  return jsonb_build_object('ok', true, 'created', true, 'job_id', v_job_id);
end;
$$;

create function public.escrow_relayer_lease(
  p_worker_id text,
  p_now timestamptz,
  p_limit integer
) returns setof public.escrow_relayer_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or p_worker_id = '' or p_limit < 1 or p_limit > 100 then
    raise exception 'escrow_relayer_lease_input_invalid';
  end if;

  return query
  with candidates as (
    select jobs.id
    from public.escrow_relayer_jobs jobs
    where jobs.attempts < jobs.max_attempts
      and (
        (jobs.state in ('pending', 'retry_wait', 'signed', 'submitted', 'unknown') and jobs.due_at <= p_now)
        or (jobs.state = 'leased' and jobs.lease_expires_at <= p_now)
      )
    order by jobs.due_at, jobs.created_at, jobs.id
    for update skip locked
    limit p_limit
  )
  update public.escrow_relayer_jobs jobs
  set state = 'leased',
      attempts = jobs.attempts + 1,
      lease_owner = p_worker_id,
      lease_token = gen_random_uuid(),
      leased_at = p_now,
      lease_expires_at = p_now + make_interval(secs => jobs.lease_duration_ms / 1000.0),
      updated_at = p_now
  from candidates
  where jobs.id = candidates.id
  returning jobs.*;
end;
$$;

create function public.escrow_relayer_record_signed(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz,
  p_raw_transaction text,
  p_expected_signature text,
  p_last_valid_block_height bigint,
  p_transaction_message_hash_hex text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.escrow_relayer_jobs%rowtype;
begin
  select * into v_job from public.escrow_relayer_jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  if v_job.lease_owner is distinct from p_worker_id
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_expires_at < p_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  if v_job.raw_transaction is not null then
    if v_job.raw_transaction = p_raw_transaction
       and v_job.expected_signature = p_expected_signature
       and v_job.last_valid_block_height = p_last_valid_block_height
       and lower(v_job.transaction_message_hash_hex) = lower(p_transaction_message_hash_hex) then
      return jsonb_build_object('ok', true, 'duplicate', true, 'state', v_job.state);
    end if;
    return jsonb_build_object('ok', false, 'code', 'signature_mismatch');
  end if;
  if v_job.state <> 'leased' then
    return jsonb_build_object('ok', false, 'code', 'state_conflict');
  end if;

  update public.escrow_relayer_jobs
  set state = 'signed',
      raw_transaction = p_raw_transaction,
      expected_signature = p_expected_signature,
      last_valid_block_height = p_last_valid_block_height,
      transaction_message_hash_hex = lower(p_transaction_message_hash_hex),
      due_at = lease_expires_at,
      updated_at = p_now
  where id = p_job_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'state', 'signed');
end;
$$;

create function public.escrow_relayer_mark_submitted(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz,
  p_expected_signature text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.escrow_relayer_jobs%rowtype;
begin
  select * into v_job from public.escrow_relayer_jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  if v_job.lease_owner is distinct from p_worker_id or v_job.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_job.expected_signature is distinct from p_expected_signature then
    return jsonb_build_object('ok', false, 'code', 'signature_mismatch');
  end if;
  if v_job.state = 'submitted' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'state', 'submitted');
  end if;
  if v_job.state <> 'signed' then
    return jsonb_build_object('ok', false, 'code', 'state_conflict');
  end if;

  update public.escrow_relayer_jobs
  set state = 'submitted',
      submitted_at = coalesce(submitted_at, p_now),
      due_at = p_now + interval '20 seconds',
      updated_at = p_now
  where id = p_job_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'state', 'submitted');
end;
$$;

create function public.escrow_relayer_retry(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz,
  p_error_code text,
  p_retry_at timestamptz,
  p_confirmation_unknown boolean,
  p_full_history_checked_at timestamptz,
  p_current_block_height bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.escrow_relayer_jobs%rowtype;
  v_next_state text;
begin
  select * into v_job from public.escrow_relayer_jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  if v_job.lease_owner is distinct from p_worker_id or v_job.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_job.state <> 'leased' then
    return jsonb_build_object('ok', false, 'code', 'state_conflict');
  end if;

  if p_confirmation_unknown then
    v_next_state := 'unknown';
  else
    if v_job.raw_transaction is not null and (
      p_full_history_checked_at is null
      or p_current_block_height is null
      or p_current_block_height <= v_job.last_valid_block_height
    ) then
      return jsonb_build_object('ok', false, 'code', 'state_conflict');
    end if;
    v_next_state := 'retry_wait';
  end if;

  update public.escrow_relayer_jobs
  set state = v_next_state,
      due_at = p_retry_at,
      error_code = p_error_code,
      full_history_checked_at = case
        when p_confirmation_unknown then full_history_checked_at
        else p_full_history_checked_at
      end,
      raw_transaction = case when p_confirmation_unknown then raw_transaction else null end,
      expected_signature = case when p_confirmation_unknown then expected_signature else null end,
      transaction_message_hash_hex = case when p_confirmation_unknown then transaction_message_hash_hex else null end,
      last_valid_block_height = case when p_confirmation_unknown then last_valid_block_height else null end,
      submitted_at = case when p_confirmation_unknown then submitted_at else null end,
      lease_owner = null,
      lease_token = null,
      leased_at = null,
      lease_expires_at = null,
      updated_at = p_now
  where id = p_job_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'state', v_next_state);
end;
$$;

create function public.escrow_relayer_complete(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.escrow_relayer_jobs%rowtype;
begin
  select * into v_job from public.escrow_relayer_jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  if v_job.state = 'complete' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'state', 'complete');
  end if;
  if v_job.lease_owner is distinct from p_worker_id or v_job.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  update public.escrow_relayer_jobs
  set state = 'complete',
      confirmed_at = coalesce(confirmed_at, p_now),
      completed_at = p_now,
      lease_owner = null,
      lease_token = null,
      leased_at = null,
      lease_expires_at = null,
      error_code = null,
      updated_at = p_now
  where id = p_job_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'state', 'complete');
end;
$$;

create function public.escrow_relayer_dead_letter(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz,
  p_error_code text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.escrow_relayer_jobs%rowtype;
begin
  select * into v_job from public.escrow_relayer_jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  if v_job.state = 'dead' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'state', 'dead');
  end if;
  if v_job.lease_owner is distinct from p_worker_id or v_job.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  update public.escrow_relayer_jobs
  set state = 'dead',
      dead_at = p_now,
      error_code = p_error_code,
      lease_owner = null,
      lease_token = null,
      leased_at = null,
      lease_expires_at = null,
      updated_at = p_now
  where id = p_job_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'state', 'dead');
end;
$$;

create function public.escrow_relayer_backlog(p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ready_count', count(*) filter (
      where state in ('pending', 'retry_wait', 'signed', 'submitted', 'unknown') and due_at <= p_now
    ),
    'leased_count', count(*) filter (where state = 'leased'),
    'unknown_count', count(*) filter (where state = 'unknown'),
    'submitted_count', count(*) filter (where state = 'submitted'),
    'dead_count', count(*) filter (where state = 'dead'),
    'oldest_ready_age_ms', case
      when min(due_at) filter (
        where state in ('pending', 'retry_wait', 'signed', 'submitted', 'unknown') and due_at <= p_now
      ) is null then null
      else greatest(0, floor(extract(epoch from (
        p_now - min(due_at) filter (
          where state in ('pending', 'retry_wait', 'signed', 'submitted', 'unknown') and due_at <= p_now
        )
      )) * 1000)::bigint)
    end
  )
  from public.escrow_relayer_jobs;
$$;

create function public.escrow_index_position_account(
  p_market_id uuid,
  p_program_id text,
  p_owner_pubkey text,
  p_position_pda text,
  p_side text,
  p_asset text,
  p_deposited_atomic numeric,
  p_pending_atomic numeric,
  p_active_atomic numeric,
  p_refundable_atomic numeric,
  p_claimed_atomic numeric,
  p_next_lot_nonce numeric,
  p_source_slot bigint,
  p_commitment text,
  p_observed_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.escrow_market_links%rowtype;
  v_existing public.escrow_position_accounts%rowtype;
  v_duplicate boolean;
begin
  select * into v_link from public.escrow_market_links
  where market_id = p_market_id and canonical
  for share;
  if v_link.market_id is null
     or v_link.program_id is distinct from p_program_id
     or v_link.asset is distinct from p_asset
     or v_link.custody_mode <> 'escrow' then
    raise exception 'escrow_position_account_market_mismatch';
  end if;

  select * into v_existing from public.escrow_position_accounts
  where market_id = p_market_id and owner_pubkey = p_owner_pubkey
  for update;
  v_duplicate := v_existing.market_id is not null
    and v_existing.source_slot = p_source_slot
    and v_existing.position_pda = p_position_pda
    and v_existing.side = p_side
    and v_existing.asset = p_asset
    and v_existing.deposited_atomic = p_deposited_atomic
    and v_existing.pending_atomic = p_pending_atomic
    and v_existing.active_atomic = p_active_atomic
    and v_existing.refundable_atomic = p_refundable_atomic
    and v_existing.claimed_atomic = p_claimed_atomic
    and v_existing.next_lot_nonce = p_next_lot_nonce
    and v_existing.commitment = p_commitment
    and v_existing.canonical;

  if v_existing.market_id is not null and (
    v_existing.position_pda is distinct from p_position_pda
    or v_existing.side is distinct from p_side
    or v_existing.asset is distinct from p_asset
  ) then
    raise exception 'escrow_position_account_identity_conflict';
  end if;

  if v_existing.market_id is null or p_source_slot >= v_existing.source_slot then
    insert into public.escrow_position_accounts (
      market_id, owner_pubkey, position_pda, side, asset, deposited_atomic,
      pending_atomic, active_atomic, refundable_atomic, claimed_atomic,
      next_lot_nonce, source_slot, commitment, canonical, updated_at
    ) values (
      p_market_id, p_owner_pubkey, p_position_pda, p_side, p_asset, p_deposited_atomic,
      p_pending_atomic, p_active_atomic, p_refundable_atomic, p_claimed_atomic,
      p_next_lot_nonce, p_source_slot, p_commitment, true, p_observed_at
    ) on conflict (market_id, owner_pubkey) do update
    set deposited_atomic = excluded.deposited_atomic,
        pending_atomic = excluded.pending_atomic,
        active_atomic = excluded.active_atomic,
        refundable_atomic = excluded.refundable_atomic,
        claimed_atomic = excluded.claimed_atomic,
        next_lot_nonce = excluded.next_lot_nonce,
        source_slot = excluded.source_slot,
        commitment = excluded.commitment,
        canonical = true,
        updated_at = excluded.updated_at;
  else
    v_duplicate := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'finalized', p_commitment = 'finalized'
  );
end;
$$;

-- PostgREST exposes public functions by default. All escrow writes and private
-- reads are service-role only; curated views above are the sole anon surface.
do $$
declare
  v_function record;
begin
  for v_function in
    select n.nspname as schema_name, p.proname as function_name,
           pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'escrow_%'
  loop
    execute format(
      'revoke all privileges on function %I.%I(%s) from public, anon, authenticated',
      v_function.schema_name, v_function.function_name, v_function.identity_arguments
    );
    execute format(
      'grant execute on function %I.%I(%s) to service_role',
      v_function.schema_name, v_function.function_name, v_function.identity_arguments
    );
  end loop;
end;
$$;
