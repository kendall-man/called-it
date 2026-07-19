-- Durable Telegram surface for pre-mint claim lifecycle recovery.
-- Nullable preserves every existing claim; the engine writes it only after
-- Telegram confirms the canonical consent/reading message was sent.
alter table claims
  add column if not exists surface_tg_message_id bigint;
