create function wager_get_wallet_link_session(
  p_token_hash_hex text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_token_hash bytea := wager_decode_sha256_hex(p_token_hash_hex);
  v_session wager_wallet_link_sessions%rowtype;
begin
  if v_token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;

  select * into v_session
  from wager_wallet_link_sessions
  where token_hash = v_token_hash
    and consumed_at is null
    and expires_at > now();

  if v_session.id is null then
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_session.user_id,
    'expires_at', v_session.expires_at
  );
end;
$$;

revoke execute on function wager_get_wallet_link_session(text) from public, anon, authenticated;
grant execute on function wager_get_wallet_link_session(text) to service_role;
