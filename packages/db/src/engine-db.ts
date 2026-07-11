/**
 * createEngineDb — thin typed data façade over @supabase/supabase-js.
 *
 * Mirrors the EngineDb port in apps/engine/src/ports.ts: same method names,
 * signatures, and snake_case row shapes, so the engine can consume it without
 * mapping. Strictly a data layer — idempotency is enforced with unique
 * constraints (ledger idempotency_key, feed_events (fixture_id, seq)), and
 * every business decision stays in the engine.
 */

import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { GamePhase, MarketStatus, MatchEvent } from '@calledit/market-engine';
import { botOnboardingDbFromClient } from './bot-onboarding-db.js';
import type { BotGroupReadyResult, BotOnboardingVersion } from './bot-onboarding-types.js';
import { assertOk, unwrapMaybe, unwrapRows, type PgResult } from './errors.js';
import type {
  Chattiness,
  ClaimInsert,
  ClaimPatch,
  ClaimRow,
  ClaimStatus,
  EntityNames,
  FixtureRow,
  FixtureUpsert,
  GroupRow,
  LeaderboardEntry,
  LedgerEntry,
  MarketInsert,
  MarketQuotePatch,
  MarketRow,
  MembershipRow,
  PlayerLite,
  PositionInsert,
  PositionRow,
  PositionState,
  ProofUpsert,
  SettlementInsert,
  SettlementRow,
  UserRow,
} from './types.js';

// ── Constants (mirroring CHECK constraints / engine semantics) ─────────────

/** Claim statuses that a TTL sweep may still flip to 'expired'. */
const NON_TERMINAL_CLAIM_STATUSES: readonly ClaimStatus[] = [
  'detected',
  'nudged',
  'clarifying',
  'awaiting_confirm',
];

/** Market statuses the settlement loop still cares about. */
const OPEN_MARKET_STATUSES: readonly MarketStatus[] = [
  'pending_lineup',
  'open',
  'frozen',
  'settling',
];

/** Phases in which a fixture is in play (or paused but expected to resume). */
const LIVE_PHASES: readonly GamePhase[] = ['H1', 'HT', 'H2', 'ET1', 'HTET', 'ET2', 'PE', 'INT'];

const FIXTURE_SEARCH_LIMIT = 20;
const PLAYER_SEARCH_LIMIT = 20;

/** 72 bits of entropy → 12-char base64url slug; unguessable per the PRD. */
const SLUG_ENTROPY_BYTES = 9;

function generateSlug(): string {
  return randomBytes(SLUG_ENTROPY_BYTES).toString('base64url');
}

/**
 * Strip characters that PostgREST's `.or()` filter grammar treats as syntax.
 * Only needed for values interpolated into or-strings (never for `.eq()` etc,
 * where supabase-js passes the value as a single opaque parameter).
 */
function sanitizeOrFilterValue(value: string): string {
  return value.replace(/[,()%\\]/g, ' ').trim();
}

// ── Façade interface (the engine's EngineDb port, re-declared here) ────────

export interface EngineDb {
  // groups
  upsertGroup(input: { id: number; title: string }): Promise<GroupRow>;
  getGroup(id: number): Promise<GroupRow | null>;
  markGroupReady(input: {
    groupId: number;
    onboardingVersion: BotOnboardingVersion;
  }): Promise<BotGroupReadyResult>;
  setGroupChattiness(id: number, chattiness: Chattiness): Promise<void>;
  setGroupAdmin(id: number, isAdmin: boolean): Promise<void>;
  setGroupWebEnabled(id: number, enabled: boolean): Promise<void>;
  listGroups(): Promise<GroupRow[]>;

  // users & memberships
  upsertUser(input: { id: number; display_name: string; username: string | null }): Promise<void>;
  getUser(id: number): Promise<UserRow | null>;
  /** Creates the membership row if missing; created=true on first interaction. */
  ensureMembership(groupId: number, userId: number): Promise<{ created: boolean }>;
  listMemberships(groupId: number): Promise<MembershipRow[]>;
  /** Ledger-derived balance (source of truth, not the display cache). */
  balance(groupId: number, userId: number): Promise<number>;
  leaderboard(groupId: number, limit: number): Promise<LeaderboardEntry[]>;

  // ledger
  /** Idempotent append; inserted=false when the idempotency key already exists. */
  postLedger(entry: LedgerEntry): Promise<{ inserted: boolean }>;
  /** Existence check for an idempotency key (API stake replay dedup). */
  hasLedgerEntry(idempotencyKey: string): Promise<boolean>;

  // claims
  insertClaim(input: ClaimInsert): Promise<ClaimRow>;
  getClaim(id: string): Promise<ClaimRow | null>;
  updateClaim(id: string, patch: ClaimPatch): Promise<void>;
  /** Flip overdue non-terminal claims to 'expired'; returns the rows expired. */
  expireOverdueClaims(nowIso: string): Promise<ClaimRow[]>;

  // markets
  insertMarket(input: MarketInsert): Promise<MarketRow>;
  getMarket(id: string): Promise<MarketRow | null>;
  updateMarketStatus(id: string, status: MarketStatus): Promise<void>;
  setMarketQuote(id: string, quote: MarketQuotePatch): Promise<void>;
  setMarketCardMessage(id: string, tgMessageId: number): Promise<void>;
  /** Markets in a non-terminal status (pending_lineup/open/frozen/settling). */
  openMarketsForFixture(fixtureId: number): Promise<MarketRow[]>;
  openMarketsForGroup(groupId: number): Promise<MarketRow[]>;

  // positions
  insertPosition(input: PositionInsert): Promise<PositionRow>;
  positionsForMarket(marketId: string): Promise<PositionRow[]>;
  setPositionStates(ids: string[], state: PositionState): Promise<void>;

  // feed events
  /** Upsert-ignore on (fixture_id, seq); inserted=false on duplicate. */
  insertFeedEvent(event: MatchEvent): Promise<{ inserted: boolean }>;

  // settlements
  insertSettlement(input: SettlementInsert): Promise<void>;
  unpostedSettlements(): Promise<SettlementRow[]>;
  markSettlementPosted(marketId: string): Promise<void>;

  // proofs
  upsertProof(input: ProofUpsert): Promise<void>;

  // stream cursors (LiveSource resume)
  getCursor(streamName: string): Promise<string | null>;
  setCursor(streamName: string, lastEventId: string): Promise<void>;

  // fixtures & players
  upsertFixtures(rows: FixtureUpsert[]): Promise<void>;
  getFixture(fixtureId: number): Promise<FixtureRow | null>;
  /** Fixtures with kickoff_at inside [fromMs, toMs). */
  fixturesBetween(fromMs: number, toMs: number): Promise<FixtureRow[]>;
  /** In a live phase, or NS with kickoff within lookaheadMs of nowMs. */
  liveFixtures(nowMs: number, lookaheadMs: number): Promise<FixtureRow[]>;
  /** Apply a normalized event's phase/minute/score/last_seq to the fixture row. */
  updateFixtureFromEvent(event: MatchEvent): Promise<void>;
  /** Name-substring fixture search used by the agent's grounded tools. */
  searchFixtures(query: string): Promise<FixtureRow[]>;
  /** Team + player dictionary for the deterministic prefilter. */
  entityNames(): Promise<EntityNames>;
  playersForFixture(fixtureId: number): Promise<PlayerLite[]>;
  searchPlayers(name: string, fixtureId?: number): Promise<PlayerLite[]>;
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createEngineDb(url: string, serviceRoleKey: string): EngineDb {
  // Service-role key bypasses RLS; this client must only ever live server-side.
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const onboarding = botOnboardingDbFromClient(client);

  return {
    // ── groups ─────────────────────────────────────────────────────────────

    async upsertGroup(input) {
      // slug is NOT NULL UNIQUE with no default, so first contact must mint
      // one — but an existing group's slug must never be rotated. Hence
      // insert-if-missing (ON CONFLICT DO NOTHING) followed by a title
      // refresh, instead of a plain upsert that would clobber the slug.
      const inserted = unwrapRows<GroupRow[]>(
        'upsertGroup.insert',
        await client
          .from('groups')
          .upsert(
            { id: input.id, title: input.title, slug: generateSlug() },
            { onConflict: 'id', ignoreDuplicates: true },
          )
          .select(),
      );
      const freshlyCreated = inserted[0];
      if (freshlyCreated) return freshlyCreated;
      return unwrapRows<GroupRow>(
        'upsertGroup.update',
        await client
          .from('groups')
          .update({ title: input.title })
          .eq('id', input.id)
          .select()
          .single(),
      );
    },

    async getGroup(id) {
      return unwrapMaybe<GroupRow>(
        'getGroup',
        await client.from('groups').select('*').eq('id', id).maybeSingle(),
      );
    },

    markGroupReady(input) {
      return onboarding.markGroupReady(input);
    },

    async setGroupChattiness(id, chattiness) {
      assertOk('setGroupChattiness', await client.from('groups').update({ chattiness }).eq('id', id));
    },

    async setGroupAdmin(id, isAdmin) {
      assertOk('setGroupAdmin', await client.from('groups').update({ is_admin: isAdmin }).eq('id', id));
    },

    async setGroupWebEnabled(id, enabled) {
      assertOk(
        'setGroupWebEnabled',
        await client.from('groups').update({ web_enabled: enabled }).eq('id', id),
      );
    },

    async listGroups() {
      return unwrapRows<GroupRow[]>('listGroups', await client.from('groups').select('*'));
    },

    // ── users & memberships ────────────────────────────────────────────────

    async upsertUser(input) {
      assertOk(
        'upsertUser',
        await client
          .from('users')
          .upsert(
            { id: input.id, display_name: input.display_name, username: input.username },
            { onConflict: 'id' },
          ),
      );
    },

    async getUser(id) {
      return unwrapMaybe<UserRow>(
        'getUser',
        await client.from('users').select('*').eq('id', id).maybeSingle(),
      );
    },

    async ensureMembership(groupId, userId) {
      // ON CONFLICT DO NOTHING returns the row only when it was inserted,
      // which is exactly the created flag. Caller must have upserted the
      // group and user first (FK constraints).
      const rows = unwrapRows<Array<{ user_id: number }>>(
        'ensureMembership',
        await client
          .from('memberships')
          .upsert(
            { group_id: groupId, user_id: userId },
            { onConflict: 'group_id,user_id', ignoreDuplicates: true },
          )
          .select('user_id'),
      );
      return { created: rows.length > 0 };
    },

    async listMemberships(groupId) {
      return unwrapRows<MembershipRow[]>(
        'listMemberships',
        await client.from('memberships').select('*').eq('group_id', groupId),
      );
    },

    async balance(groupId, userId) {
      const rows = unwrapRows<Array<{ amount: number }>>(
        'balance',
        await client
          .from('ledger_entries')
          .select('amount')
          .eq('group_id', groupId)
          .eq('user_id', userId),
      );
      return rows.reduce((sum, row) => sum + row.amount, 0);
    },

    async leaderboard(groupId, limit) {
      type JoinedRow = {
        user_id: number;
        points_cached: number;
        streak: number;
        users: { display_name: string } | null;
      };
      // Cast: memberships.user_id → users.id is many-to-one, so PostgREST
      // embeds `users` as an object; untyped supabase-js infers an array.
      const result = (await client
        .from('memberships')
        .select('user_id, points_cached, streak, users(display_name)')
        .eq('group_id', groupId)
        .order('points_cached', { ascending: false })
        .order('user_id', { ascending: true })
        .limit(limit)) as unknown as PgResult<JoinedRow[]>;
      const rows = unwrapRows('leaderboard', result);
      return rows.map((row) => ({
        user_id: row.user_id,
        display_name: row.users?.display_name ?? '',
        points_cached: row.points_cached,
        streak: row.streak,
      }));
    },

    // ── ledger ─────────────────────────────────────────────────────────────

    async postLedger(entry) {
      const rows = unwrapRows<Array<{ id: number }>>(
        'postLedger',
        await client
          .from('ledger_entries')
          .upsert(entry, { onConflict: 'idempotency_key', ignoreDuplicates: true })
          .select('id'),
      );
      return { inserted: rows.length > 0 };
    },

    async hasLedgerEntry(idempotencyKey) {
      const rows = unwrapRows<Array<{ id: number }>>(
        'hasLedgerEntry',
        await client
          .from('ledger_entries')
          .select('id')
          .eq('idempotency_key', idempotencyKey)
          .limit(1),
      );
      return rows.length > 0;
    },

    // ── claims ─────────────────────────────────────────────────────────────

    async insertClaim(input) {
      return unwrapRows<ClaimRow>(
        'insertClaim',
        await client.from('claims').insert(input).select().single(),
      );
    },

    async getClaim(id) {
      return unwrapMaybe<ClaimRow>(
        'getClaim',
        await client.from('claims').select('*').eq('id', id).maybeSingle(),
      );
    },

    async updateClaim(id, patch) {
      // Drop undefined keys (absent = "leave column alone") but keep explicit
      // nulls (e.g. clearing expires_at); skip the round trip on empty patch.
      const changes = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(changes).length === 0) return;
      assertOk('updateClaim', await client.from('claims').update(changes).eq('id', id));
    },

    async expireOverdueClaims(nowIso) {
      return unwrapRows<ClaimRow[]>(
        'expireOverdueClaims',
        await client
          .from('claims')
          .update({ status: 'expired' satisfies ClaimStatus })
          .in('status', [...NON_TERMINAL_CLAIM_STATUSES])
          .lte('expires_at', nowIso)
          .select(),
      );
    },

    // ── markets ────────────────────────────────────────────────────────────

    async insertMarket(input) {
      return unwrapRows<MarketRow>(
        'insertMarket',
        await client.from('markets').insert(input).select().single(),
      );
    },

    async getMarket(id) {
      return unwrapMaybe<MarketRow>(
        'getMarket',
        await client.from('markets').select('*').eq('id', id).maybeSingle(),
      );
    },

    async updateMarketStatus(id, status) {
      assertOk('updateMarketStatus', await client.from('markets').update({ status }).eq('id', id));
    },

    async setMarketQuote(id, quote) {
      assertOk('setMarketQuote', await client.from('markets').update(quote).eq('id', id));
    },

    async setMarketCardMessage(id, tgMessageId) {
      assertOk(
        'setMarketCardMessage',
        await client.from('markets').update({ card_tg_message_id: tgMessageId }).eq('id', id),
      );
    },

    async openMarketsForFixture(fixtureId) {
      return unwrapRows<MarketRow[]>(
        'openMarketsForFixture',
        await client
          .from('markets')
          .select('*')
          .eq('fixture_id', fixtureId)
          .in('status', [...OPEN_MARKET_STATUSES]),
      );
    },

    async openMarketsForGroup(groupId) {
      return unwrapRows<MarketRow[]>(
        'openMarketsForGroup',
        await client
          .from('markets')
          .select('*')
          .eq('group_id', groupId)
          .in('status', [...OPEN_MARKET_STATUSES]),
      );
    },

    // ── positions ──────────────────────────────────────────────────────────

    async insertPosition(input) {
      return unwrapRows<PositionRow>(
        'insertPosition',
        await client.from('positions').insert(input).select().single(),
      );
    },

    async positionsForMarket(marketId) {
      return unwrapRows<PositionRow[]>(
        'positionsForMarket',
        await client.from('positions').select('*').eq('market_id', marketId),
      );
    },

    async setPositionStates(ids, state) {
      if (ids.length === 0) return;
      assertOk('setPositionStates', await client.from('positions').update({ state }).in('id', ids));
    },

    // ── feed events ────────────────────────────────────────────────────────

    async insertFeedEvent(event) {
      const rows = unwrapRows<Array<{ seq: number }>>(
        'insertFeedEvent',
        await client
          .from('feed_events')
          .upsert(
            {
              fixture_id: event.fixtureId,
              seq: event.seq,
              ts_ms: event.tsMs,
              received_at_ms: event.receivedAtMs,
              kind: event.kind,
              confirmed: event.confirmed,
              // The whole normalized MatchEvent is the payload — derived
              // facts only, never raw TxLINE, per the data-license posture.
              payload: event as unknown as Record<string, unknown>,
            },
            { onConflict: 'fixture_id,seq', ignoreDuplicates: true },
          )
          .select('seq'),
      );
      return { inserted: rows.length > 0 };
    },

    // ── settlements ────────────────────────────────────────────────────────

    async insertSettlement(input) {
      // market_id is the primary key; upsert-ignore makes crash-retry of the
      // settlement loop safe (first outcome written wins, duplicates no-op).
      assertOk(
        'insertSettlement',
        await client
          .from('settlements')
          .upsert(input, { onConflict: 'market_id', ignoreDuplicates: true }),
      );
    },

    async unpostedSettlements() {
      return unwrapRows<SettlementRow[]>(
        'unpostedSettlements',
        await client.from('settlements').select('*').is('posted_at', null),
      );
    },

    async markSettlementPosted(marketId) {
      assertOk(
        'markSettlementPosted',
        await client
          .from('settlements')
          .update({ posted_at: new Date().toISOString() })
          .eq('market_id', marketId),
      );
    },

    // ── proofs ─────────────────────────────────────────────────────────────

    async upsertProof(input) {
      // proofs has no unique constraint on (market_id, kind), so Postgres
      // ON CONFLICT can't express this upsert; emulate with lookup + write.
      // Single-writer proof worker per market makes the race window moot.
      const existing = unwrapMaybe<{ id: string }>(
        'upsertProof.lookup',
        await client
          .from('proofs')
          .select('id')
          .eq('market_id', input.market_id)
          .eq('kind', input.kind)
          .limit(1)
          .maybeSingle(),
      );
      const row = {
        ...input,
        merkle_proof: input.merkle_proof as Record<string, unknown> | null,
        verified_at: input.status === 'verified' ? new Date().toISOString() : null,
      };
      if (existing) {
        assertOk('upsertProof.update', await client.from('proofs').update(row).eq('id', existing.id));
      } else {
        assertOk('upsertProof.insert', await client.from('proofs').insert(row));
      }
    },

    // ── stream cursors ─────────────────────────────────────────────────────

    async getCursor(streamName) {
      const row = unwrapMaybe<{ last_event_id: string | null }>(
        'getCursor',
        await client
          .from('stream_cursors')
          .select('last_event_id')
          .eq('stream_name', streamName)
          .maybeSingle(),
      );
      return row?.last_event_id ?? null;
    },

    async setCursor(streamName, lastEventId) {
      assertOk(
        'setCursor',
        await client
          .from('stream_cursors')
          .upsert(
            {
              stream_name: streamName,
              last_event_id: lastEventId,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'stream_name' },
          ),
      );
    },

    // ── fixtures & players ─────────────────────────────────────────────────

    async upsertFixtures(rows) {
      if (rows.length === 0) return;
      // Upsert touches only the snapshot columns supplied here — live-state
      // columns (phase/minute/score/last_seq) are owned by the feed path.
      const updatedAt = new Date().toISOString();
      assertOk(
        'upsertFixtures',
        await client
          .from('fixtures')
          .upsert(
            rows.map((row) => ({ ...row, updated_at: updatedAt })),
            { onConflict: 'fixture_id' },
          ),
      );
    },

    async getFixture(fixtureId) {
      return unwrapMaybe<FixtureRow>(
        'getFixture',
        await client.from('fixtures').select('*').eq('fixture_id', fixtureId).maybeSingle(),
      );
    },

    async fixturesBetween(fromMs, toMs) {
      return unwrapRows<FixtureRow[]>(
        'fixturesBetween',
        await client
          .from('fixtures')
          .select('*')
          .gte('kickoff_at', new Date(fromMs).toISOString())
          .lt('kickoff_at', new Date(toMs).toISOString())
          .order('kickoff_at', { ascending: true }),
      );
    },

    async liveFixtures(nowMs, lookaheadMs) {
      // "Within lookaheadMs of nowMs" is read symmetrically for NS fixtures:
      // a match that kicked off moments ago but whose row still says NS must
      // stay attachable until the first phase_change lands.
      const windowStart = new Date(nowMs - lookaheadMs).toISOString();
      const windowEnd = new Date(nowMs + lookaheadMs).toISOString();
      return unwrapRows<FixtureRow[]>(
        'liveFixtures',
        await client
          .from('fixtures')
          .select('*')
          .or(
            `phase.in.(${LIVE_PHASES.join(',')}),` +
              `and(phase.eq.NS,kickoff_at.gte.${windowStart},kickoff_at.lte.${windowEnd})`,
          ),
      );
    },

    async updateFixtureFromEvent(event) {
      // lte guard keeps the watermark monotonic: replayed or gap-fill events
      // with an older seq can never regress phase/score.
      assertOk(
        'updateFixtureFromEvent',
        await client
          .from('fixtures')
          .update({
            phase: event.phase,
            minute: event.minute,
            score: event.score as unknown as Record<string, unknown>,
            last_seq: event.seq,
            updated_at: new Date().toISOString(),
          })
          .eq('fixture_id', event.fixtureId)
          .lte('last_seq', event.seq),
      );
    },

    async searchFixtures(query) {
      const needle = sanitizeOrFilterValue(query);
      if (needle.length === 0) return [];
      return unwrapRows<FixtureRow[]>(
        'searchFixtures',
        await client
          .from('fixtures')
          .select('*')
          .or(`p1_name.ilike.%${needle}%,p2_name.ilike.%${needle}%`)
          .order('kickoff_at', { ascending: false, nullsFirst: false })
          .limit(FIXTURE_SEARCH_LIMIT),
      );
    },

    async entityNames() {
      const [fixturesRes, playersRes] = await Promise.all([
        client.from('fixtures').select('p1_name, p2_name'),
        client.from('players').select('preferred_name, aliases'),
      ]);
      const fixtures = unwrapRows<Array<{ p1_name: string; p2_name: string }>>(
        'entityNames.fixtures',
        fixturesRes,
      );
      const players = unwrapRows<Array<{ preferred_name: string; aliases: string[] }>>(
        'entityNames.players',
        playersRes,
      );
      const teamNames = new Set<string>();
      for (const fixture of fixtures) {
        if (fixture.p1_name) teamNames.add(fixture.p1_name);
        if (fixture.p2_name) teamNames.add(fixture.p2_name);
      }
      const playerNames = new Set<string>();
      for (const player of players) {
        if (player.preferred_name) playerNames.add(player.preferred_name);
        for (const alias of player.aliases) {
          if (alias) playerNames.add(alias);
        }
      }
      return { teamNames: [...teamNames], playerNames: [...playerNames] };
    },

    async playersForFixture(fixtureId) {
      type JoinedRow = {
        normative_id: number | null;
        participant: 1 | 2 | null;
        players: { preferred_name: string } | null;
      };
      // Cast: fixture_players.normative_id → players is many-to-one (object
      // embed at runtime); untyped supabase-js infers an array.
      const result = (await client
        .from('fixture_players')
        .select('normative_id, participant, players(preferred_name)')
        .eq('fixture_id', fixtureId)) as unknown as PgResult<JoinedRow[]>;
      const rows = unwrapRows('playersForFixture', result);
      return rows
        .filter((row) => row.normative_id !== null && row.players !== null)
        .map((row) => ({
          normativeId: row.normative_id as number,
          name: (row.players as { preferred_name: string }).preferred_name,
          participant: row.participant,
        }));
    },

    async searchPlayers(name, fixtureId) {
      const pattern = `%${name}%`;
      if (fixtureId === undefined) {
        const rows = unwrapRows<Array<{ normative_id: number; preferred_name: string }>>(
          'searchPlayers',
          await client
            .from('players')
            .select('normative_id, preferred_name')
            .ilike('preferred_name', pattern)
            .limit(PLAYER_SEARCH_LIMIT),
        );
        return rows.map((row) => ({
          normativeId: row.normative_id,
          name: row.preferred_name,
          participant: null,
        }));
      }
      type JoinedRow = {
        normative_id: number | null;
        participant: 1 | 2 | null;
        players: { preferred_name: string };
      };
      // Cast: many-to-one inner join embeds `players` as an object at
      // runtime; untyped supabase-js infers an array.
      const result = (await client
        .from('fixture_players')
        .select('normative_id, participant, players!inner(preferred_name)')
        .eq('fixture_id', fixtureId)
        .ilike('players.preferred_name', pattern)
        .limit(PLAYER_SEARCH_LIMIT)) as unknown as PgResult<JoinedRow[]>;
      const rows = unwrapRows('searchPlayers.fixture', result);
      return rows
        .filter((row) => row.normative_id !== null)
        .map((row) => ({
          normativeId: row.normative_id as number,
          name: row.players.preferred_name,
          participant: row.participant,
        }));
    },
  };
}
