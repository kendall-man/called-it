-- Network-scoped Privy identities for escrow. The legacy wager_wallet_links
-- table remains unchanged so prior custodial balances and withdrawals retain
-- their original ownership model.

create table public.escrow_wallet_links (
  user_id             bigint not null references public.users(id),
  solana_network      text not null check (solana_network in ('devnet', 'mainnet-beta')),
  pubkey               text not null check (pubkey ~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$'),
  wallet_provider      text not null default 'privy' check (wallet_provider = 'privy'),
  provider_user_id     text not null check (provider_user_id <> '' and length(provider_user_id) <= 255),
  provider_wallet_id   text not null check (provider_wallet_id <> '' and length(provider_wallet_id) <= 255),
  challenge_id         uuid not null references public.wager_wallet_challenges(id),
  verified_at          timestamptz not null default now(),
  primary key (user_id, solana_network),
  unique (solana_network, pubkey),
  unique (solana_network, provider_user_id),
  unique (solana_network, provider_wallet_id)
);

alter table public.escrow_wallet_links enable row level security;

insert into public.escrow_wallet_links (
  user_id, solana_network, pubkey, provider_user_id, provider_wallet_id,
  challenge_id, verified_at
)
select
  link.user_id, link.solana_network, link.pubkey, link.provider_user_id,
  link.provider_wallet_id, history.challenge_id, link.verified_at
from public.wager_wallet_links link
join public.wager_wallet_link_history history on history.id = link.link_history_id
where link.wallet_provider = 'privy'
  and link.solana_network in ('devnet', 'mainnet-beta')
  and link.provider_user_id is not null
  and link.provider_wallet_id is not null
on conflict do nothing;

create function public.escrow_verify_privy_wallet_link_session(
  p_token_hash_hex text,
  p_challenge_id uuid,
  p_pubkey text,
  p_challenge_hash_hex text,
  p_provider_user_id text,
  p_provider_wallet_id text,
  p_solana_network text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token_hash bytea := public.wager_decode_sha256_hex(p_token_hash_hex);
  v_challenge_hash bytea := public.wager_decode_sha256_hex(p_challenge_hash_hex);
  v_session public.wager_wallet_link_sessions%rowtype;
  v_current public.escrow_wallet_links%rowtype;
  v_relinked boolean := false;
begin
  if v_token_hash is null or v_challenge_hash is null
     or p_pubkey !~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$'
     or p_provider_user_id is null or p_provider_user_id = '' or length(p_provider_user_id) > 255
     or p_provider_wallet_id is null or p_provider_wallet_id = '' or length(p_provider_wallet_id) > 255
     or p_solana_network not in ('devnet', 'mainnet-beta') then
    return jsonb_build_object('ok', false, 'code', 'privy_identity_invalid');
  end if;

  select * into v_session
  from public.wager_wallet_link_sessions
  where token_hash = v_token_hash and consumed_at is null and expires_at > now()
  for update;
  if v_session.id is null then
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;
  if v_session.solana_network <> p_solana_network then
    return jsonb_build_object('ok', false, 'code', 'wallet_network_mismatch');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'escrow:wallet:user:' || v_session.user_id::text || ':' || p_solana_network, 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'escrow:wallet:provider-user:' || p_provider_user_id || ':' || p_solana_network, 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'escrow:wallet:provider-wallet:' || p_provider_wallet_id || ':' || p_solana_network, 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'escrow:wallet:pubkey:' || p_pubkey || ':' || p_solana_network, 0
  ));

  if not exists (
    select 1 from public.wager_wallet_challenges challenge
    where challenge.id = p_challenge_id
      and challenge.session_id = v_session.id
      and challenge.user_id = v_session.user_id
      and challenge.pubkey = p_pubkey
      and challenge.challenge_hash = v_challenge_hash
      and challenge.consumed_at is null
      and challenge.expires_at > now()
  ) then
    if exists (
      select 1 from public.wager_wallet_challenges challenge
      where challenge.id = p_challenge_id
        and challenge.session_id = v_session.id
        and challenge.user_id = v_session.user_id
        and challenge.pubkey = p_pubkey
        and challenge.challenge_hash = v_challenge_hash
        and challenge.consumed_at is null
        and challenge.expires_at <= now()
    ) then
      return jsonb_build_object('ok', false, 'code', 'challenge_expired');
    end if;
    return jsonb_build_object('ok', false, 'code', 'challenge_invalid');
  end if;

  if exists (
    select 1 from public.escrow_wallet_links
    where solana_network = p_solana_network and pubkey = p_pubkey
      and user_id <> v_session.user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'pubkey_reserved');
  end if;
  if exists (
    select 1 from public.escrow_wallet_links
    where solana_network = p_solana_network
      and provider_user_id = p_provider_user_id
      and user_id <> v_session.user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'privy_identity_reserved');
  end if;
  if exists (
    select 1 from public.escrow_wallet_links
    where solana_network = p_solana_network
      and provider_wallet_id = p_provider_wallet_id
      and user_id <> v_session.user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'privy_wallet_reserved');
  end if;

  select * into v_current from public.escrow_wallet_links
  where user_id = v_session.user_id and solana_network = p_solana_network
  for update;
  v_relinked := v_current.user_id is not null and v_current.pubkey <> p_pubkey;

  update public.wager_wallet_challenges
  set consumed_at = now()
  where id = p_challenge_id and consumed_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'challenge_invalid');
  end if;

  insert into public.wager_wallet_provider_identities (
    wallet_provider, provider_user_id, solana_network, user_id
  ) values (
    'privy', p_provider_user_id, p_solana_network, v_session.user_id
  ) on conflict (wallet_provider, provider_user_id, solana_network) do nothing;

  insert into public.escrow_wallet_links (
    user_id, solana_network, pubkey, provider_user_id, provider_wallet_id,
    challenge_id, verified_at
  ) values (
    v_session.user_id, p_solana_network, p_pubkey, p_provider_user_id,
    p_provider_wallet_id, p_challenge_id, now()
  ) on conflict (user_id, solana_network) do update
    set pubkey = excluded.pubkey,
        provider_user_id = excluded.provider_user_id,
        provider_wallet_id = excluded.provider_wallet_id,
        challenge_id = excluded.challenge_id,
        verified_at = excluded.verified_at;

  update public.wager_wallet_link_sessions
  set consumed_at = now()
  where id = v_session.id and consumed_at is null;
  if not found then
    raise exception 'escrow_wallet_session_consume_failed';
  end if;

  return jsonb_build_object('ok', true, 'relinked', v_relinked);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'privy_identity_reserved');
end;
$$;

revoke execute on function public.escrow_verify_privy_wallet_link_session(
  text, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.escrow_verify_privy_wallet_link_session(
  text, uuid, text, text, text, text, text
) to service_role;

create or replace function public.escrow_create_signing_session(
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
    select 1 from public.escrow_wallet_links wallet
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
    authorization_payload, expires_at, created_at, updated_at
  ) values (
    v_token_hash, p_user_id, p_provider_user_id, p_provider_wallet_id, p_owner_pubkey,
    p_market_id, p_side, p_asset, p_amount_atomic, p_lot_nonce, p_event_epoch,
    lower(p_document_hash_hex), lower(p_transaction_message_hash_hex),
    p_raw_transaction_base64, p_authorization, p_expires_at, p_now, p_now
  );

  return jsonb_build_object('ok', true, 'created', true);
end;
$$;
