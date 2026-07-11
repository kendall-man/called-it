import type { MatchEvent, MarketStatus } from '@calledit/market-engine';
import type {
  ClaimRow,
  EngineDb,
  FixtureRow,
  FixtureUpsert,
  GroupRow,
  LedgerEntry,
  MembershipRow,
  MarketRow,
  PlayerLite,
  PositionRow,
  SettlementRow,
  UserRow,
} from '../ports.js';
import type {
  ApplyGroupPointsResult,
  GroupPlayerStats,
  LeaderboardEntry,
  PointResult,
  PositionParticipant,
} from '../ports/rows.js';
import {
  PointFixtureMismatch,
  validatePointTransition,
  type PointTransition,
} from './telegram-points-flow-source-validator.test-support.js';

export type PersistedPointState = {
  readonly marketStatus: MarketStatus;
  readonly pointsApplied: boolean;
  readonly pointEvents: readonly PointResult[];
  readonly settlementPosted: boolean;
};

export class PointReadOutage extends Error {
  readonly name = 'PointReadOutage';
  constructor(readonly marketId: string) {
    super(`Injected point read outage for ${marketId}`);
  }
}

class MissingFlowFixture extends Error {
  readonly name = 'MissingFlowFixture';
  constructor(readonly fixture: 'market' | 'user', readonly id: string | number) {
    super(`Missing harness ${fixture} ${id}`);
  }
}

export class TelegramFlowDb implements EngineDb {
  readonly trace: string[] = [];
  private readonly groups = new Map<number, GroupRow>();
  private readonly users = new Map<number, UserRow>();
  private readonly memberships = new Map<string, MembershipRow>();
  private readonly claims = new Map<string, ClaimRow>();
  private readonly markets = new Map<string, MarketRow>();
  private readonly positions = new Map<string, PositionRow[]>();
  private readonly settlements = new Map<string, SettlementRow>();
  private readonly transitions = new Map<string, PointTransition>();
  private readonly results = new Map<string, readonly PointResult[]>();
  private readonly stats = new Map<string, GroupPlayerStats>();
  private readonly boards = new Map<number, readonly LeaderboardEntry[]>();
  private readonly applied = new Set<string>();
  private readonly readOutages = new Set<string>();
  private readonly feedEvents = new Set<string>();
  private readonly ledgers = new Set<string>();
  private readonly cursors = new Map<string, string>();
  private readonly fixtures = new Map<number, FixtureRow>();
  private claimSequence = 1;
  private marketSequence = 1;
  private positionSequence = 1;

  constructor(private readonly now: () => number) {}

  seedGroup(group: GroupRow): void { this.groups.set(group.id, group); }
  seedUser(user: UserRow): void { this.users.set(user.id, user); }
  seedFixture(fixture: FixtureRow): void { this.fixtures.set(fixture.fixture_id, fixture); }
  setPointTransition(marketId: string, transition: PointTransition): void {
    if (this.transitions.has(marketId)) {
      throw new PointFixtureMismatch(marketId, 'duplicate_configuration');
    }
    this.transitions.set(marketId, transition);
  }
  injectPointReadOutage(marketId: string): void { this.readOutages.add(marketId); }
  marketList(): readonly MarketRow[] { return [...this.markets.values()]; }
  applyCount(marketId: string): number {
    return this.trace.filter((entry) => entry === `points:apply:${marketId}`).length;
  }
  persistedPointState(marketId: string): PersistedPointState {
    const market = this.requireMarket(marketId);
    const settlement = this.settlements.get(marketId);
    return {
      marketStatus: market.status,
      pointsApplied: this.applied.has(marketId),
      pointEvents: this.results.get(marketId) ?? [],
      settlementPosted: settlement !== undefined && settlement.posted_at !== null,
    };
  }
  persistedScoringBytes(marketId: string): string {
    const market = this.requireMarket(marketId);
    const stats = [...this.stats.values()]
      .filter((entry) => entry.group_id === market.group_id)
      .sort((left, right) => left.user_id - right.user_id);
    return JSON.stringify({
      marker: this.applied.has(marketId) ? { market_id: marketId } : null,
      events: this.results.get(marketId) ?? [],
      stats,
    });
  }

  async upsertGroup(input: { id: number; title: string }): Promise<GroupRow> {
    const existing = this.groups.get(input.id);
    const group = existing ?? { id: input.id, title: input.title, slug: `group-${Math.abs(input.id)}`, web_enabled: true, chattiness: 'nudge', is_admin: true };
    this.groups.set(input.id, { ...group, title: input.title });
    return this.groups.get(input.id) ?? group;
  }
  async getGroup(id: number): Promise<GroupRow | null> { return this.groups.get(id) ?? null; }
  async markGroupReady(input: { groupId: number; onboardingVersion: 'calledit_v1' }) {
    return { ok: true, created: false, groupId: input.groupId, onboardingVersion: input.onboardingVersion } as const;
  }
  async setGroupChattiness(id: number, chattiness: GroupRow['chattiness']): Promise<void> {
    const group = this.groups.get(id); if (group) this.groups.set(id, { ...group, chattiness });
  }
  async setGroupAdmin(id: number, isAdmin: boolean): Promise<void> {
    const group = this.groups.get(id); if (group) this.groups.set(id, { ...group, is_admin: isAdmin });
  }
  async setGroupWebEnabled(id: number, enabled: boolean): Promise<void> {
    const group = this.groups.get(id); if (group) this.groups.set(id, { ...group, web_enabled: enabled });
  }
  async listGroups(): Promise<GroupRow[]> { return [...this.groups.values()]; }

  async upsertUser(input: { id: number; display_name: string; username: string | null }): Promise<void> {
    this.users.set(input.id, input);
  }
  async getUser(id: number): Promise<UserRow | null> { return this.users.get(id) ?? null; }
  async ensureMembership(groupId: number, userId: number): Promise<{ created: boolean }> {
    const key = this.memberKey(groupId, userId); const created = !this.memberships.has(key);
    if (created) this.memberships.set(key, { group_id: groupId, user_id: userId, points_cached: 0, streak: 0 });
    return { created };
  }
  async listMemberships(groupId: number): Promise<MembershipRow[]> {
    return [...this.memberships.values()].filter((row) => row.group_id === groupId);
  }
  async balance(): Promise<number> { return 0; }
  async applyGroupPoints(marketId: string): Promise<ApplyGroupPointsResult> {
    this.trace.push(`points:apply:${marketId}`);
    const transition = this.transitions.get(marketId);
    if (transition === undefined) return { ok: false, code: 'settlement_missing' };
    const market = this.requireMarket(marketId);
    validatePointTransition({
      market,
      settlement: this.settlements.get(marketId),
      positions: this.positions.get(marketId) ?? [],
      transition,
    });
    if (this.applied.has(marketId)) return transition.retry;
    this.applied.add(marketId);
    this.results.set(marketId, transition.results);
    for (const projection of transition.stats) this.stats.set(this.memberKey(projection.group_id, projection.user_id), projection);
    this.boards.set(transition.first.group_id, transition.leaderboard);
    return transition.first;
  }
  async pointResultsForMarket(marketId: string): Promise<readonly PointResult[]> {
    this.trace.push(`points:read:${marketId}`);
    if (this.readOutages.delete(marketId)) throw new PointReadOutage(marketId);
    return this.results.get(marketId) ?? [];
  }
  async groupPlayerStats(groupId: number, userId: number): Promise<GroupPlayerStats> {
    return this.stats.get(this.memberKey(groupId, userId)) ?? { group_id: groupId, user_id: userId, points: 0, wins: 0, losses: 0, accuracy: 0, current_streak: 0, best_streak: 0 };
  }
  async leaderboard(groupId: number, limit: number): Promise<readonly LeaderboardEntry[]> {
    return (this.boards.get(groupId) ?? []).slice(0, limit);
  }
  async positionParticipantsForMarket(marketId: string): Promise<readonly PositionParticipant[]> {
    const market = this.requireMarket(marketId);
    return (this.positions.get(marketId) ?? []).filter((row) => row.state !== 'void').map((row) => {
      const user = this.requireUser(row.user_id);
      return { group_id: market.group_id, market_id: marketId, user_id: row.user_id, side: row.side, display_name: user.display_name, username: user.username };
    });
  }

  async postLedger(entry: LedgerEntry): Promise<{ inserted: boolean }> {
    const inserted = !this.ledgers.has(entry.idempotency_key); this.ledgers.add(entry.idempotency_key); return { inserted };
  }
  async hasLedgerEntry(key: string): Promise<boolean> { return this.ledgers.has(key); }
  async insertClaim(input: Omit<ClaimRow, 'id' | 'parse' | 'created_at'>): Promise<ClaimRow> {
    const id = this.uuid(1, this.claimSequence++); const row = { ...input, id, parse: null, created_at: new Date(this.now()).toISOString() };
    this.claims.set(id, row); return row;
  }
  async getClaim(id: string): Promise<ClaimRow | null> { return this.claims.get(id) ?? null; }
  async updateClaim(id: string, patch: Partial<{ status: ClaimRow['status']; parse: unknown; expires_at: string | null }>): Promise<void> {
    const row = this.claims.get(id); if (row) this.claims.set(id, { ...row, ...patch });
  }
  async expireOverdueClaims(): Promise<ClaimRow[]> { return []; }
  async insertMarket(input: Omit<MarketRow, 'id' | 'card_tg_message_id' | 'created_at'>): Promise<MarketRow> {
    const id = this.uuid(2, this.marketSequence++); const row = { ...input, id, card_tg_message_id: null, created_at: new Date(this.now()).toISOString() };
    this.markets.set(id, row); this.positions.set(id, []); return row;
  }
  async getMarket(id: string): Promise<MarketRow | null> { return this.markets.get(id) ?? null; }
  async updateMarketStatus(id: string, status: MarketStatus): Promise<void> { const row = this.markets.get(id); if (row) this.markets.set(id, { ...row, status }); }
  async setMarketQuote(id: string, quote: Pick<MarketRow, 'quote_probability' | 'quote_multiplier' | 'odds_message_id' | 'odds_ts'>): Promise<void> { const row = this.markets.get(id); if (row) this.markets.set(id, { ...row, ...quote }); }
  async setMarketCardMessage(id: string, messageId: number): Promise<void> { const row = this.markets.get(id); if (row) this.markets.set(id, { ...row, card_tg_message_id: messageId }); }
  async openMarketsForFixture(fixtureId: number): Promise<MarketRow[]> { return [...this.markets.values()].filter((row) => row.fixture_id === fixtureId && row.status !== 'settled' && row.status !== 'voided'); }
  async openMarketsForGroup(groupId: number): Promise<MarketRow[]> { return [...this.markets.values()].filter((row) => row.group_id === groupId && row.status !== 'settled' && row.status !== 'voided'); }
  async insertPosition(input: Omit<PositionRow, 'id'> & { locked_odds_message_id: string | null; locked_odds_ts: number | null }): Promise<PositionRow> {
    const row: PositionRow = { id: this.uuid(3, this.positionSequence++), market_id: input.market_id, user_id: input.user_id, side: input.side, stake: input.stake, locked_multiplier: input.locked_multiplier, state: input.state, placed_at_ms: input.placed_at_ms };
    const rows = this.positions.get(input.market_id) ?? []; this.positions.set(input.market_id, [...rows, row]); return row;
  }
  async positionsForMarket(id: string): Promise<PositionRow[]> { return [...(this.positions.get(id) ?? [])]; }
  async setPositionStates(ids: string[], state: PositionRow['state']): Promise<void> { for (const [marketId, rows] of this.positions) this.positions.set(marketId, rows.map((row) => ids.includes(row.id) ? { ...row, state } : row)); }
  async insertFeedEvent(event: MatchEvent): Promise<{ inserted: boolean }> { const key = `${event.fixtureId}:${event.seq}`; const inserted = !this.feedEvents.has(key); this.feedEvents.add(key); return { inserted }; }
  async insertSettlement(input: Omit<SettlementRow, 'posted_at' | 'settled_at'>): Promise<void> { this.settlements.set(input.market_id, { ...input, posted_at: null, settled_at: new Date(this.now()).toISOString() }); }
  async unpostedSettlements(): Promise<SettlementRow[]> { return [...this.settlements.values()].filter((row) => row.posted_at === null); }
  async markSettlementPosted(marketId: string): Promise<void> { const row = this.settlements.get(marketId); if (row) this.settlements.set(marketId, { ...row, posted_at: new Date(this.now()).toISOString() }); this.trace.push(`receipt:posted:${marketId}`); }
  async upsertProof(): Promise<void> {}
  async getCursor(name: string): Promise<string | null> { return this.cursors.get(name) ?? null; }
  async setCursor(name: string, value: string): Promise<void> { this.cursors.set(name, value); }
  async upsertFixtures(rows: FixtureUpsert[]): Promise<void> { for (const row of rows) this.seedFixture({ fixture_id: row.fixture_id, p1_name: row.p1_name, p2_name: row.p2_name, kickoff_at: row.kickoff_at, phase: 'NS', minute: null, last_seq: 0, score: {}, coverage_unreliable: false }); }
  async getFixture(id: number): Promise<FixtureRow | null> { return this.fixtures.get(id) ?? null; }
  async fixturesBetween(): Promise<FixtureRow[]> { return [...this.fixtures.values()]; }
  async liveFixtures(): Promise<FixtureRow[]> { return [...this.fixtures.values()]; }
  async updateFixtureFromEvent(event: MatchEvent): Promise<void> { const row = this.fixtures.get(event.fixtureId); if (row) this.fixtures.set(event.fixtureId, { ...row, phase: event.phase, minute: event.minute, last_seq: event.seq, score: { p1: event.score.p1.goals, p2: event.score.p2.goals } }); }
  async searchFixtures(query: string): Promise<FixtureRow[]> { return [...this.fixtures.values()].filter((row) => `${row.p1_name} ${row.p2_name}`.toLowerCase().includes(query.toLowerCase())); }
  async entityNames(): Promise<{ teamNames: string[]; playerNames: string[] }> { return { teamNames: [...this.fixtures.values()].flatMap((row) => [row.p1_name, row.p2_name]), playerNames: [] }; }
  async playersForFixture(): Promise<PlayerLite[]> { return []; }
  async searchPlayers(): Promise<PlayerLite[]> { return []; }

  private memberKey(groupId: number, userId: number): string { return `${groupId}:${userId}`; }
  private requireMarket(id: string): MarketRow { const row = this.markets.get(id); if (row === undefined) throw new MissingFlowFixture('market', id); return row; }
  private requireUser(id: number): UserRow { const row = this.users.get(id); if (row === undefined) throw new MissingFlowFixture('user', id); return row; }
  private uuid(kind: number, sequence: number): string { return `${kind}0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`; }
}
