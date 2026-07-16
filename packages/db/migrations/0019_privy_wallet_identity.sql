alter table wager_wallet_links
  add column wallet_provider text not null default 'legacy_local'
    check (wallet_provider in ('legacy_local', 'privy')),
  add column provider_user_id text,
  add column provider_wallet_id text,
  add column solana_network text
    check (solana_network in ('devnet', 'mainnet-beta')),
  add constraint wager_wallet_links_privy_metadata_check check (
    wallet_provider = 'legacy_local'
    or (
      provider_user_id is not null and provider_user_id <> ''
      and provider_wallet_id is not null and provider_wallet_id <> ''
      and solana_network is not null
    )
  );

alter table wager_wallet_link_history
  add column wallet_provider text not null default 'legacy_local'
    check (wallet_provider in ('legacy_local', 'privy')),
  add column provider_user_id text,
  add column provider_wallet_id text,
  add column solana_network text
    check (solana_network in ('devnet', 'mainnet-beta')),
  add constraint wager_wallet_link_history_privy_metadata_check check (
    wallet_provider = 'legacy_local'
    or (
      provider_user_id is not null and provider_user_id <> ''
      and provider_wallet_id is not null and provider_wallet_id <> ''
      and solana_network is not null
    )
  );

create unique index wager_wallet_link_history_privy_wallet_key
  on wager_wallet_link_history (provider_wallet_id, solana_network)
  where wallet_provider = 'privy';

create table wager_wallet_provider_identities (
  wallet_provider     text not null check (wallet_provider = 'privy'),
  provider_user_id    text not null check (provider_user_id <> ''),
  solana_network      text not null check (solana_network in ('devnet', 'mainnet-beta')),
  user_id             bigint not null references users(id),
  created_at          timestamptz not null default now(),
  primary key (wallet_provider, provider_user_id, solana_network),
  unique (wallet_provider, user_id, solana_network)
);

alter table wager_wallet_provider_identities enable row level security;

create function wager_verify_privy_wallet_link_session(
  p_token_hash_hex text,
  p_challenge_id uuid,
  p_pubkey text,
  p_challenge_hash_hex text,
  p_provider_user_id text,
  p_provider_wallet_id text,
  p_solana_network text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_token_hash bytea := wager_decode_sha256_hex(p_token_hash_hex);
  v_session wager_wallet_link_sessions%rowtype;
  v_identity_user_id bigint;
  v_wallet_user_id bigint;
  v_result jsonb;
  v_link_id bigint;
begin
  if v_token_hash is null
     or p_provider_user_id is null or p_provider_user_id = '' or length(p_provider_user_id) > 255
     or p_provider_wallet_id is null or p_provider_wallet_id = '' or length(p_provider_wallet_id) > 255
     or p_solana_network not in ('devnet', 'mainnet-beta') then
    return jsonb_build_object('ok', false, 'code', 'privy_identity_invalid');
  end if;

  select * into v_session
  from wager_wallet_link_sessions
  where token_hash = v_token_hash and consumed_at is null and expires_at > now();
  if v_session.id is null then
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wallet:user:' || v_session.user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('wallet:privy:user:' || p_provider_user_id || ':' || p_solana_network, 0));
  perform pg_advisory_xact_lock(hashtextextended('wallet:privy:wallet:' || p_provider_wallet_id || ':' || p_solana_network, 0));

  select user_id into v_identity_user_id
  from wager_wallet_provider_identities
  where wallet_provider = 'privy'
    and provider_user_id = p_provider_user_id
    and solana_network = p_solana_network;
  if v_identity_user_id is not null and v_identity_user_id <> v_session.user_id then
    return jsonb_build_object('ok', false, 'code', 'privy_identity_reserved');
  end if;
  if exists (
    select 1 from wager_wallet_provider_identities
    where wallet_provider = 'privy'
      and user_id = v_session.user_id
      and solana_network = p_solana_network
      and provider_user_id <> p_provider_user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'privy_identity_reserved');
  end if;

  select user_id into v_wallet_user_id
  from wager_wallet_link_history
  where wallet_provider = 'privy'
    and provider_wallet_id = p_provider_wallet_id
    and solana_network = p_solana_network;
  if v_wallet_user_id is not null and v_wallet_user_id <> v_session.user_id then
    return jsonb_build_object('ok', false, 'code', 'privy_wallet_reserved');
  end if;

  v_result := wager_verify_wallet_link_session(
    p_token_hash_hex,
    p_challenge_id,
    p_pubkey,
    p_challenge_hash_hex
  );
  if not coalesce((v_result->>'ok')::boolean, false) then
    return v_result;
  end if;

  insert into wager_wallet_provider_identities (
    wallet_provider, provider_user_id, solana_network, user_id
  ) values (
    'privy', p_provider_user_id, p_solana_network, v_session.user_id
  ) on conflict (wallet_provider, provider_user_id, solana_network) do nothing;

  v_link_id := (v_result->>'link_id')::bigint;
  update wager_wallet_link_history
  set wallet_provider = 'privy',
      provider_user_id = p_provider_user_id,
      provider_wallet_id = p_provider_wallet_id,
      solana_network = p_solana_network
  where id = v_link_id and user_id = v_session.user_id and pubkey = p_pubkey;
  if not found then
    raise exception 'verified wallet history row missing';
  end if;

  update wager_wallet_links
  set wallet_provider = 'privy',
      provider_user_id = p_provider_user_id,
      provider_wallet_id = p_provider_wallet_id,
      solana_network = p_solana_network
  where user_id = v_session.user_id and link_history_id = v_link_id and pubkey = p_pubkey;
  if not found then
    raise exception 'verified wallet link row missing';
  end if;

  return v_result;
end;
$$;

revoke execute on function wager_verify_privy_wallet_link_session(
  text, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function wager_verify_privy_wallet_link_session(
  text, uuid, text, text, text, text, text
) to service_role;
