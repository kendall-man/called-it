create or replace function wager_create_wallet_link_challenge(
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
  v_expires_at timestamptz;
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

  v_expires_at := least(p_expires_at, v_session.expires_at);
  if v_expires_at <= now() or v_expires_at > now() + interval '6 minutes' then
    return jsonb_build_object('ok', false, 'code', 'challenge_invalid');
  end if;

  update wager_wallet_challenges
  set consumed_at = now()
  where session_id = v_session.id and consumed_at is null;

  insert into wager_wallet_challenges (
    id, user_id, pubkey, challenge_hash, expires_at, session_id
  ) values (
    p_challenge_id, v_session.user_id, p_pubkey, v_challenge_hash, v_expires_at, v_session.id
  ) returning * into v_challenge;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_session.user_id,
    'issued_at', v_challenge.issued_at,
    'expires_at', v_challenge.expires_at
  );
end;
$$;
