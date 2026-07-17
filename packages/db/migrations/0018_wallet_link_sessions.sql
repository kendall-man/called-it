create table wager_wallet_link_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     bigint not null references users(id),
  token_hash  bytea not null unique check (octet_length(token_hash) = 32),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

create index wager_wallet_link_sessions_user_idx
  on wager_wallet_link_sessions (user_id, expires_at desc);

alter table wager_wallet_link_sessions enable row level security;

alter table wager_wallet_challenges
  add column session_id uuid references wager_wallet_link_sessions(id);

create index wager_wallet_challenges_session_idx
  on wager_wallet_challenges (session_id, expires_at)
  where consumed_at is null;

create function wager_create_wallet_link_session(
  p_user_id bigint,
  p_token_hash_hex text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_hash bytea := wager_decode_sha256_hex(p_token_hash_hex);
  v_id uuid;
begin
  if v_hash is null or p_expires_at <= now() or p_expires_at > now() + interval '15 minutes' then
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;
  if not exists (select 1 from users where id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'user_not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wallet:session:user:' || p_user_id::text, 0));
  update wager_wallet_link_sessions
  set consumed_at = now()
  where user_id = p_user_id and consumed_at is null;

  insert into wager_wallet_link_sessions (user_id, token_hash, expires_at)
  values (p_user_id, v_hash, p_expires_at)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'session_id', v_id);
end;
$$;

create function wager_create_wallet_link_challenge(
  p_token_hash_hex text,
  p_challenge_id uuid,
  p_pubkey text,
  p_challenge_hash_hex text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_token_hash bytea := wager_decode_sha256_hex(p_token_hash_hex);
  v_challenge_hash bytea := wager_decode_sha256_hex(p_challenge_hash_hex);
  v_session wager_wallet_link_sessions%rowtype;
  v_challenge wager_wallet_challenges%rowtype;
begin
  if v_token_hash is null or v_challenge_hash is null or p_pubkey !~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$' then
    return jsonb_build_object('ok', false, 'code', 'challenge_invalid');
  end if;

  select * into v_session
  from wager_wallet_link_sessions
  where token_hash = v_token_hash and consumed_at is null and expires_at > now()
  for update;
  if v_session.id is null then
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;
  if p_expires_at <= now() or p_expires_at > v_session.expires_at or p_expires_at > now() + interval '6 minutes' then
    return jsonb_build_object('ok', false, 'code', 'challenge_invalid');
  end if;

  update wager_wallet_challenges
  set consumed_at = now()
  where session_id = v_session.id and consumed_at is null;

  insert into wager_wallet_challenges (
    id, user_id, pubkey, challenge_hash, expires_at, session_id
  ) values (
    p_challenge_id, v_session.user_id, p_pubkey, v_challenge_hash, p_expires_at, v_session.id
  ) returning * into v_challenge;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_session.user_id,
    'issued_at', v_challenge.issued_at,
    'expires_at', v_challenge.expires_at
  );
end;
$$;

create function wager_get_wallet_link_challenge(
  p_token_hash_hex text,
  p_challenge_id uuid
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_token_hash bytea := wager_decode_sha256_hex(p_token_hash_hex);
  v_row record;
begin
  if v_token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;
  select c.user_id, c.pubkey, c.issued_at, c.expires_at, encode(c.challenge_hash, 'hex') as challenge_hash_hex
  into v_row
  from wager_wallet_challenges c
  join wager_wallet_link_sessions s on s.id = c.session_id
  where s.token_hash = v_token_hash
    and s.consumed_at is null
    and s.expires_at > now()
    and c.id = p_challenge_id
    and c.consumed_at is null
    and c.expires_at > now();
  if v_row.user_id is null then
    return jsonb_build_object('ok', false, 'code', 'challenge_invalid');
  end if;
  return jsonb_build_object(
    'ok', true,
    'user_id', v_row.user_id,
    'pubkey', v_row.pubkey,
    'issued_at', v_row.issued_at,
    'expires_at', v_row.expires_at,
    'challenge_hash_hex', v_row.challenge_hash_hex
  );
end;
$$;

create function wager_verify_wallet_link_session(
  p_token_hash_hex text,
  p_challenge_id uuid,
  p_pubkey text,
  p_challenge_hash_hex text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_token_hash bytea := wager_decode_sha256_hex(p_token_hash_hex);
  v_session wager_wallet_link_sessions%rowtype;
  v_challenge_session_id uuid;
  v_result jsonb;
begin
  if v_token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;
  select * into v_session
  from wager_wallet_link_sessions
  where token_hash = v_token_hash and consumed_at is null and expires_at > now()
  for update;
  if v_session.id is null then
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;
  select session_id into v_challenge_session_id
  from wager_wallet_challenges
  where id = p_challenge_id and user_id = v_session.user_id and pubkey = p_pubkey;
  if v_challenge_session_id is distinct from v_session.id then
    return jsonb_build_object('ok', false, 'code', 'challenge_invalid');
  end if;

  v_result := wager_verify_wallet_link(
    p_challenge_id,
    v_session.user_id,
    p_pubkey,
    p_challenge_hash_hex
  );
  if coalesce((v_result->>'ok')::boolean, false) then
    update wager_wallet_link_sessions set consumed_at = now() where id = v_session.id;
  end if;
  return v_result;
end;
$$;

revoke execute on function wager_create_wallet_link_session(bigint, text, timestamptz) from public, anon, authenticated;
revoke execute on function wager_create_wallet_link_challenge(text, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function wager_get_wallet_link_challenge(text, uuid) from public, anon, authenticated;
revoke execute on function wager_verify_wallet_link_session(text, uuid, text, text) from public, anon, authenticated;

grant execute on function wager_create_wallet_link_session(bigint, text, timestamptz) to service_role;
grant execute on function wager_create_wallet_link_challenge(text, uuid, text, text, timestamptz) to service_role;
grant execute on function wager_get_wallet_link_challenge(text, uuid) to service_role;
grant execute on function wager_verify_wallet_link_session(text, uuid, text, text) to service_role;
