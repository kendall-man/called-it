-- Called It — initial schema (PRD v1.1 data model)
-- Engine writes via service_role (bypasses RLS). Web reads via anon through
-- read-only views. Zero client-side writes exist anywhere.

create table groups (
  id            bigint primary key,              -- Telegram chat id
  title         text not null default '',
  slug          text not null unique,            -- unguessable public URL slug
  web_enabled   boolean not null default true,
  chattiness    text not null default 'nudge'
                check (chattiness in ('nudge', 'react_only', 'trigger_only')),
  is_admin      boolean not null default false,  -- bot promoted to group admin (passive detection consent)
  created_at    timestamptz not null default now()
);

create table users (
  id            bigint primary key,              -- Telegram user id
  display_name  text not null default '',
  username      text,
  first_seen_at timestamptz not null default now()
);

create table memberships (
  group_id      bigint not null references groups(id),
  user_id       bigint not null references users(id),
  points_cached bigint not null default 0,       -- display cache; ledger is source of truth
  last_topup_at timestamptz,
  streak        int not null default 0,
  primary key (group_id, user_id)
);

create table ledger_entries (
  id              bigserial primary key,
  group_id        bigint not null references groups(id),
  user_id         bigint not null references users(id),
  market_id       uuid,
  kind            text not null check (kind in ('stake', 'payout', 'refund', 'topup', 'seed')),
  amount          bigint not null,               -- signed Rep delta
  idempotency_key text not null unique,
  created_at      timestamptz not null default now()
);

create table fixtures (
  fixture_id           bigint primary key,
  competition_id       bigint,
  p1_id                bigint,
  p1_name              text not null default '',
  p2_id                bigint,
  p2_name              text not null default '',
  kickoff_at           timestamptz,
  phase                text not null default 'NS',
  minute               int,
  last_seq             bigint not null default 0,  -- settlement watermark
  score                jsonb not null default '{}'::jsonb,
  coverage_unreliable  boolean not null default false,
  updated_at           timestamptz not null default now()
);

create table players (
  normative_id   bigint primary key,
  preferred_name text not null,
  team           text,
  aliases        text[] not null default '{}',
  updated_at     timestamptz not null default now()
);

create table fixture_players (
  fixture_id        bigint not null references fixtures(fixture_id),
  fixture_player_id bigint not null,
  normative_id      bigint references players(normative_id),
  participant       int check (participant in (1, 2)),
  roster_number     int,
  starter           boolean not null default false,
  primary key (fixture_id, fixture_player_id)
);

create table claims (
  id                    uuid primary key default gen_random_uuid(),
  group_id              bigint not null references groups(id),
  claimer_user_id       bigint not null references users(id),
  tg_message_id         bigint not null,
  quoted_text           text not null,
  status                text not null default 'detected'
                        check (status in ('detected','nudged','clarifying','awaiting_confirm','confirmed','declined','expired')),
  classifier_confidence real,
  parse                 jsonb,                    -- RawClaimParse from the agent
  expires_at            timestamptz,
  created_at            timestamptz not null default now()
);

create table markets (
  id                uuid primary key default gen_random_uuid(),
  claim_id          uuid not null references claims(id),
  group_id          bigint not null references groups(id),
  fixture_id        bigint not null references fixtures(fixture_id),
  spec              jsonb not null,               -- compiled MarketSpec
  status            text not null default 'open'
                    check (status in ('pending_lineup','open','frozen','settling','settled','voided')),
  is_replay         boolean not null default false,
  price_provenance  text not null check (price_provenance in ('market','modelled')),
  quote_probability real not null,
  quote_multiplier  real not null,
  odds_message_id   text,                         -- REQUIRED pin for /api/odds/validation proof
  odds_ts           bigint,
  card_tg_message_id bigint,
  created_at        timestamptz not null default now()
);

create table positions (
  id                uuid primary key default gen_random_uuid(),
  market_id         uuid not null references markets(id),
  user_id           bigint not null references users(id),
  side              text not null check (side in ('back','doubt')),
  stake             bigint not null,
  locked_multiplier real not null,
  locked_odds_message_id text,
  locked_odds_ts    bigint,
  state             text not null default 'pending'
                    check (state in ('pending','active','void')),
  placed_at_ms      bigint not null,              -- wall clock; drives delay-arbitrage guard
  created_at        timestamptz not null default now()
);

create table feed_events (
  fixture_id  bigint not null,
  seq         bigint not null,
  ts_ms       bigint not null,
  received_at_ms bigint not null,
  kind        text not null,
  confirmed   boolean not null default false,
  payload     jsonb not null,                     -- normalized MatchEvent (derived facts, not raw TxLINE)
  inserted_at timestamptz not null default now(),
  primary key (fixture_id, seq)
);

create table settlements (
  market_id     uuid primary key references markets(id),
  outcome       text not null check (outcome in ('claim_won','claim_lost','void')),
  deciding_seq  bigint,
  evidence_seqs bigint[] not null default '{}',
  tier          text not null check (tier in ('chain_proven','oracle_resolved')),
  posted_at     timestamptz,                      -- null = chat delivery pending (sweeper re-sends)
  settled_at    timestamptz not null default now()
);

create table proofs (
  id                uuid primary key default gen_random_uuid(),
  market_id         uuid not null references markets(id),
  kind              text not null check (kind in ('stat','odds')),
  stat_key          int,
  seq               bigint,
  merkle_proof      jsonb,
  validate_stat_tx  text,
  explorer_url      text,
  status            text not null default 'pending'
                    check (status in ('pending','verified','failed','unavailable')),
  verified_at       timestamptz
);

create table stream_cursors (
  stream_name   text primary key,
  last_event_id text,
  updated_at    timestamptz not null default now()
);

-- ── Public read surface (web, anon key) ──────────────────────────────────

create view public_receipts as
select
  m.id as market_id, g.slug as group_slug, g.web_enabled,
  c.quoted_text, u.display_name as claimer_name,
  m.spec, m.status, m.is_replay, m.price_provenance,
  m.quote_probability, m.quote_multiplier, m.created_at,
  s.outcome, s.deciding_seq, s.evidence_seqs, s.tier, s.settled_at,
  p.status as proof_status, p.explorer_url, p.validate_stat_tx,
  p.merkle_proof, p.stat_key, p.seq as proof_seq
from markets m
join groups g on g.id = m.group_id
join claims c on c.id = m.claim_id
join users u on u.id = c.claimer_user_id
left join settlements s on s.market_id = m.id
left join proofs p on p.market_id = m.id
where g.web_enabled;

create view public_leaderboard as
select g.slug as group_slug, u.display_name, ms.points_cached, ms.streak
from memberships ms
join groups g on g.id = ms.group_id
join users u on u.id = ms.user_id
where g.web_enabled;

-- Derived per-event facts only (event type / minute / seq / confirmation) —
-- never raw TxLINE payloads — per the data-license posture in the PRD.
create view public_evidence as
select fe.fixture_id, fe.seq, fe.kind, fe.confirmed,
       (fe.payload->>'minute')::int as minute,
       fe.payload->'detail'->>'playerName' as player_name,
       fe.payload->'detail'->>'goalType' as goal_type
from feed_events fe;

-- ── RLS: anon may read only the curated views' base tables via the views ─
alter table groups enable row level security;
alter table users enable row level security;
alter table memberships enable row level security;
alter table ledger_entries enable row level security;
alter table fixtures enable row level security;
alter table players enable row level security;
alter table fixture_players enable row level security;
alter table claims enable row level security;
alter table markets enable row level security;
alter table positions enable row level security;
alter table feed_events enable row level security;
alter table settlements enable row level security;
alter table proofs enable row level security;
alter table stream_cursors enable row level security;

-- Views run as owner (postgres) in Supabase, so anon gets exactly the view
-- surface and nothing else — EXCEPT settlements/proofs, which get direct anon
-- read policies: Supabase Realtime (postgres_changes) respects RLS, and the
-- receipt page's live badge-flip subscribes to these two tables. They contain
-- only derived, non-personal data (market ids, outcomes, proof material).
create policy anon_read_settlements on settlements for select using (true);
create policy anon_read_proofs on proofs for select using (true);

-- Realtime publications:
alter publication supabase_realtime add table settlements, proofs, markets;
