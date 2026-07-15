-- Standalone, privacy-safe public receipt terms for finalized escrow markets.
--
-- 0024 remains immutable. This migration appends compatible columns to its
-- public receipt view and snapshots the off-chain display terms at the moment
-- an escrow market link is first indexed. Existing malformed projections are
-- not published; new malformed links are rejected.

alter table public.escrow_market_links
  add column public_terms_version smallint,
  add column public_fixture_id bigint,
  add column public_fixture_p1_name text,
  add column public_fixture_p2_name text,
  add column public_spec jsonb,
  add column public_replay_flag boolean,
  add column public_kickoff_at timestamptz,
  add column public_market_created_at timestamptz,
  add column public_price_provenance text,
  add column public_quote_probability double precision,
  add column public_quote_multiplier double precision,
  add column public_probability_ppm numeric(20, 0),
  add constraint escrow_market_links_public_terms_shape check (
    (
      public_terms_version is null
      and public_fixture_id is null
      and public_fixture_p1_name is null
      and public_fixture_p2_name is null
      and public_spec is null
      and public_replay_flag is null
      and public_kickoff_at is null
      and public_market_created_at is null
      and public_price_provenance is null
      and public_quote_probability is null
      and public_quote_multiplier is null
      and public_probability_ppm is null
    )
    or (
      public_terms_version = 1
      and public_fixture_id is not null and public_fixture_id >= 0
      and public_fixture_p1_name is not null and public_fixture_p1_name <> ''
      and public_fixture_p2_name is not null and public_fixture_p2_name <> ''
      and jsonb_typeof(public_spec) = 'object'
      and public_replay_flag is not null
      and public_market_created_at is not null
      and public_price_provenance in ('market', 'modelled')
      and public_quote_probability > 0 and public_quote_probability < 1
      and public_quote_multiplier > 0
      and public_quote_multiplier < 'Infinity'::double precision
      and public_probability_ppm between 1 and 999999
    )
  );

-- Existing valid links receive the same immutable snapshot a new link would.
-- Invalid or conflicting rows retain null snapshot columns and are therefore
-- absent from the public view until an operator repairs and reindexes them.
with candidates as (
  select
    m.id as market_id,
    m.fixture_id,
    f.p1_name,
    f.p2_name,
    m.spec,
    m.is_replay,
    f.kickoff_at,
    m.created_at,
    m.price_provenance,
    m.quote_probability,
    m.quote_multiplier,
    round(m.quote_probability::numeric * 1000000)::numeric(20, 0) as probability_ppm
  from public.markets m
  join public.fixtures f on f.fixture_id = m.fixture_id
  where m.custody_mode = 'escrow'
    and m.currency in ('sol', 'usdc')
    and m.fixture_id >= 0
    and f.p1_name <> ''
    and f.p2_name <> ''
    and jsonb_typeof(m.spec) = 'object'
    and case
      when jsonb_typeof(m.spec->'fixtureId') = 'number'
       and (m.spec->>'fixtureId') ~ '^[0-9]+$'
      then (m.spec->>'fixtureId')::numeric = m.fixture_id
      else false
    end
    and m.spec->>'claimType' in (
      'match_winner', 'totals_ou', 'team_scores_n',
      'btts', 'player_scores_n', 'comeback'
    )
    and m.spec->>'comparator' in ('gte', 'lte', 'eq')
    and m.spec->>'period' in ('FT', 'FT_90')
    and m.spec->>'trustTier' in ('chain_proven', 'oracle_resolved')
    and jsonb_typeof(m.spec->'threshold') = 'number'
    and (m.spec->>'threshold')::numeric >= 0
    and jsonb_typeof(m.spec->'entityRef') = 'object'
    and m.spec->'entityRef'->>'kind' in ('team', 'player')
    and coalesce(m.spec->'entityRef'->>'name', '') <> ''
    and char_length(m.spec->'entityRef'->>'name') <= 96
    and m.quote_probability > 0 and m.quote_probability < 1
    and m.quote_multiplier > 0
    and m.quote_multiplier < 'Infinity'::double precision
), valid_candidates as (
  select
    candidates.*,
    greatest(
      floor(
        (
          (1000000 - probability_ppm) * 1000
          + floor(probability_ppm / 2)
        ) / probability_ppm
      ),
      1
    )::numeric(20, 0) as expected_ratio
  from candidates
  where probability_ppm between 1 and 999999
)
update public.escrow_market_links ml
set public_terms_version = 1,
    public_fixture_id = source.fixture_id,
    public_fixture_p1_name = source.p1_name,
    public_fixture_p2_name = source.p2_name,
    public_spec = source.spec,
    public_replay_flag = source.is_replay,
    public_kickoff_at = source.kickoff_at,
    public_market_created_at = source.created_at,
    public_price_provenance = source.price_provenance,
    public_quote_probability = source.quote_probability,
    public_quote_multiplier = source.quote_multiplier,
    public_probability_ppm = source.probability_ppm
from valid_candidates source
where ml.market_id = source.market_id
  and ml.asset = (select currency from public.markets where id = source.market_id)
  and ml.ratio_milli = source.expected_ratio;

create function public.escrow_capture_public_market_terms()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_market record;
  v_probability_ppm numeric(20, 0);
  v_expected_ratio numeric(20, 0);
begin
  if tg_op = 'UPDATE' and old.public_terms_version is not null then
    if new.public_terms_version is distinct from old.public_terms_version
       or new.public_fixture_id is distinct from old.public_fixture_id
       or new.public_fixture_p1_name is distinct from old.public_fixture_p1_name
       or new.public_fixture_p2_name is distinct from old.public_fixture_p2_name
       or new.public_spec is distinct from old.public_spec
       or new.public_replay_flag is distinct from old.public_replay_flag
       or new.public_kickoff_at is distinct from old.public_kickoff_at
       or new.public_market_created_at is distinct from old.public_market_created_at
       or new.public_price_provenance is distinct from old.public_price_provenance
       or new.public_quote_probability is distinct from old.public_quote_probability
       or new.public_quote_multiplier is distinct from old.public_quote_multiplier
       or new.public_probability_ppm is distinct from old.public_probability_ppm then
      raise exception 'escrow_public_market_terms_conflict';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and (
    new.public_terms_version is not null
    or new.public_fixture_id is not null
    or new.public_fixture_p1_name is not null
    or new.public_fixture_p2_name is not null
    or new.public_spec is not null
    or new.public_replay_flag is not null
    or new.public_kickoff_at is not null
    or new.public_market_created_at is not null
    or new.public_price_provenance is not null
    or new.public_quote_probability is not null
    or new.public_quote_multiplier is not null
    or new.public_probability_ppm is not null
  ) then
    raise exception 'escrow_public_market_terms_conflict';
  end if;

  select
    m.custody_mode,
    m.currency,
    m.fixture_id,
    f.p1_name,
    f.p2_name,
    f.kickoff_at,
    m.spec,
    m.is_replay,
    m.created_at,
    m.price_provenance,
    m.quote_probability,
    m.quote_multiplier
  into v_market
  from public.markets m
  join public.fixtures f on f.fixture_id = m.fixture_id
  where m.id = new.market_id;

  if not found then
    raise exception 'escrow_public_market_terms_invalid';
  end if;

  if v_market.custody_mode is distinct from 'escrow'
     or new.custody_mode is distinct from 'escrow'
     or v_market.currency is distinct from new.asset
     or v_market.fixture_id < 0
     or v_market.p1_name is null or v_market.p1_name = ''
     or v_market.p2_name is null or v_market.p2_name = ''
     or jsonb_typeof(v_market.spec) <> 'object'
     or jsonb_typeof(v_market.spec->'fixtureId') is distinct from 'number'
     or not coalesce((v_market.spec->>'fixtureId') ~ '^[0-9]+$', false)
     or coalesce(v_market.spec->>'claimType' not in (
       'match_winner', 'totals_ou', 'team_scores_n',
       'btts', 'player_scores_n', 'comeback'
     ), true)
     or coalesce(v_market.spec->>'comparator' not in ('gte', 'lte', 'eq'), true)
     or coalesce(v_market.spec->>'period' not in ('FT', 'FT_90'), true)
     or coalesce(v_market.spec->>'trustTier' not in ('chain_proven', 'oracle_resolved'), true)
     or jsonb_typeof(v_market.spec->'threshold') is distinct from 'number'
     or (v_market.spec->>'threshold')::numeric < 0
     or jsonb_typeof(v_market.spec->'entityRef') is distinct from 'object'
     or v_market.spec->'entityRef'->>'kind' not in ('team', 'player')
     or coalesce(v_market.spec->'entityRef'->>'name', '') = ''
     or char_length(v_market.spec->'entityRef'->>'name') > 96
     or not (v_market.quote_probability > 0 and v_market.quote_probability < 1)
     or not (v_market.quote_multiplier > 0)
     or not (v_market.quote_multiplier < 'Infinity'::double precision) then
    raise exception 'escrow_public_market_terms_invalid';
  end if;

  if (v_market.spec->>'fixtureId')::numeric is distinct from v_market.fixture_id then
    raise exception 'escrow_public_market_terms_invalid';
  end if;

  v_probability_ppm := round(v_market.quote_probability::numeric * 1000000);
  if v_probability_ppm not between 1 and 999999 then
    raise exception 'escrow_public_market_terms_invalid';
  end if;
  v_expected_ratio := greatest(
    floor(
      (
        (1000000 - v_probability_ppm) * 1000
        + floor(v_probability_ppm / 2)
      ) / v_probability_ppm
    ),
    1
  );
  if new.ratio_milli is distinct from v_expected_ratio then
    raise exception 'escrow_public_market_terms_invalid';
  end if;

  new.public_terms_version := 1;
  new.public_fixture_id := v_market.fixture_id;
  new.public_fixture_p1_name := v_market.p1_name;
  new.public_fixture_p2_name := v_market.p2_name;
  new.public_spec := v_market.spec;
  new.public_replay_flag := v_market.is_replay;
  new.public_kickoff_at := v_market.kickoff_at;
  new.public_market_created_at := v_market.created_at;
  new.public_price_provenance := v_market.price_provenance;
  new.public_quote_probability := v_market.quote_probability;
  new.public_quote_multiplier := v_market.quote_multiplier;
  new.public_probability_ppm := v_probability_ppm;
  return new;
end;
$$;

create trigger escrow_market_links_capture_public_terms
before insert or update on public.escrow_market_links
for each row execute function public.escrow_capture_public_market_terms();

create function public.escrow_public_market_terms_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.custody_mode = 'escrow'
     and exists (
       select 1 from public.escrow_market_links ml where ml.market_id = old.id
     )
     and (
       new.claim_id is distinct from old.claim_id
       or new.group_id is distinct from old.group_id
       or new.fixture_id is distinct from old.fixture_id
       or new.spec is distinct from old.spec
       or new.is_replay is distinct from old.is_replay
       or new.price_provenance is distinct from old.price_provenance
       or new.quote_probability is distinct from old.quote_probability
       or new.quote_multiplier is distinct from old.quote_multiplier
       or new.currency is distinct from old.currency
       or new.created_at is distinct from old.created_at
     ) then
    raise exception 'escrow_public_market_terms_immutable';
  end if;
  return new;
end;
$$;

create trigger markets_keep_escrow_public_terms_immutable
before update of
  claim_id, group_id, fixture_id, spec, is_replay, price_provenance,
  quote_probability, quote_multiplier, currency, created_at
on public.markets
for each row execute function public.escrow_public_market_terms_immutable();

revoke all on function public.escrow_capture_public_market_terms()
from public, anon, authenticated;
revoke all on function public.escrow_public_market_terms_immutable()
from public, anon, authenticated;

-- The original 0024 columns remain first and unchanged. New standalone terms
-- are appended so rolling web deployments can keep their explicit old select.
create or replace view public.public_escrow_receipts
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
  se.block_time as settled_at,
  ml.public_fixture_id as fixture_id,
  ml.public_fixture_p1_name as fixture_p1_name,
  ml.public_fixture_p2_name as fixture_p2_name,
  ml.public_spec as spec,
  ml.public_replay_flag as is_replay,
  ml.public_kickoff_at as kickoff_at,
  ml.public_market_created_at as created_at,
  ml.public_price_provenance as price_provenance,
  ml.public_quote_probability as quote_probability,
  ml.public_quote_multiplier as quote_multiplier,
  ml.public_probability_ppm as probability_ppm,
  ml.ratio_milli,
  ml.asset as currency,
  ml.genesis_hash,
  ml.mint_pubkey,
  ml.custody_version,
  ml.chain_state,
  ml.initialize_instruction_index,
  ml.initialize_block_time,
  se.instruction_index as settlement_instruction_index,
  case
    when ml.chain_state = 'closed' and se.outcome = 'void' then 'voided'
    when ml.chain_state = 'closed' then 'settled'
    else ml.chain_state
  end as status
from public.escrow_market_links ml
join public.markets m on m.id = ml.market_id
join public.groups g on g.id = m.group_id
join public.escrow_chain_event_identities initialize_identity
  on initialize_identity.signature = ml.initialize_signature
 and initialize_identity.instruction_index = ml.initialize_instruction_index
 and initialize_identity.cluster = ml.cluster
 and initialize_identity.program_id = ml.program_id
 and initialize_identity.event_kind = 'market'
 and initialize_identity.slot = ml.initialize_slot
 and initialize_identity.canonical
 and initialize_identity.commitment = 'finalized'
left join public.escrow_settlement_events se
  on se.market_id = ml.market_id
 and se.program_id = ml.program_id
 and lower(se.document_hash_hex) = lower(ml.document_hash_hex)
 and se.canonical
 and se.commitment = 'finalized'
left join public.escrow_chain_event_identities settlement_identity
  on settlement_identity.signature = se.signature
 and settlement_identity.instruction_index = se.instruction_index
 and settlement_identity.cluster = ml.cluster
 and settlement_identity.program_id = ml.program_id
 and settlement_identity.event_kind = 'settlement'
 and settlement_identity.slot = se.slot
 and settlement_identity.canonical
 and settlement_identity.commitment = 'finalized'
where g.web_enabled
  and m.custody_mode = 'escrow'
  and ml.custody_mode = 'escrow'
  and ml.asset = m.currency
  and ml.public_terms_version = 1
  and ml.public_fixture_id = m.fixture_id
  and ml.public_spec = m.spec
  and ml.public_replay_flag = m.is_replay
  and ml.public_market_created_at = m.created_at
  and ml.public_price_provenance = m.price_provenance
  and ml.public_quote_probability = m.quote_probability
  and ml.public_quote_multiplier = m.quote_multiplier
  and ml.ratio_milli = greatest(
    floor(
      (
        (1000000 - ml.public_probability_ppm) * 1000
        + floor(ml.public_probability_ppm / 2)
      ) / ml.public_probability_ppm
    ),
    1
  )
  and ml.canonical
  and ml.commitment = 'finalized'
  and not ml.projection_stale
  and (
    (se.market_id is null and ml.chain_state in ('open', 'frozen'))
    or (
      se.market_id is not null
      and settlement_identity.signature is not null
      and (
        (se.outcome = 'void' and ml.chain_state in ('voided', 'closed'))
        or (
          se.outcome in ('claim_won', 'claim_lost')
          and ml.chain_state in ('settled', 'closed')
        )
      )
    )
  );

revoke all privileges on table public.public_escrow_receipts
from public, anon, authenticated;
grant select on table public.public_escrow_receipts
to anon, authenticated, service_role;

-- Public aggregate and claim views remain exactly as defined by 0024. Revoke
-- and regrant their read-only contract so upgrades verify all three together.
revoke all privileges on table
  public.public_escrow_position_aggregates,
  public.public_escrow_claim_transactions
from public, anon, authenticated;
grant select on table
  public.public_escrow_position_aggregates,
  public.public_escrow_claim_transactions
to anon, authenticated, service_role;
