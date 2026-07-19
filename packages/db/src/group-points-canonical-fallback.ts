import type { GroupPointsDbClient } from './group-points-contract.js';
import {
  booleanField,
  contractFailure,
  nullableStringField,
  positiveIntegerField,
  record,
  rows,
  safeIntegerField,
  stringField,
} from './group-points-parser-core.js';
import type { LeaderboardEntry } from './group-points-types.js';

const OP = 'canonicalGroupStatsFallback';
const MAX_MARKETS = 250;
// PostgREST commonly caps responses at 1,000 rows. Request one sentinel row
// above our accepted maximum so truncation is observable instead of silent.
const MAX_FACT_ROWS = 999;
const MAX_USERS = 999;

type Side = 'back' | 'doubt';
type Result = 'won' | 'lost';

type ScoreEvent = {
  readonly marketId: string;
  readonly userId: number;
  readonly side: Side;
  readonly result: Result;
  readonly settledAtMs: number;
};

type Market = {
  readonly id: string;
  readonly custodyMode: 'legacy' | 'escrow';
};

type Link = {
  readonly marketId: string;
  readonly programId: string;
  readonly documentHashHex: string;
};

type Settlement = {
  readonly marketId: string;
  readonly outcome: 'claim_won' | 'claim_lost';
  readonly tier: 'chain_proven' | 'oracle_resolved';
  readonly settledAtMs: number;
};

type ChainSettlement = {
  readonly marketId: string;
  readonly outcome: 'claim_won' | 'claim_lost';
  readonly programId: string;
  readonly documentHashHex: string;
};

type CanonicalEscrowProjection = {
  readonly events: readonly ScoreEvent[];
  readonly outcomes: ReadonlyMap<string, Settlement>;
};

type Lot = {
  readonly marketId: string;
  readonly ownerPubkey: string;
  readonly lotNonce: string;
  readonly positionPda: string;
  readonly side: Side;
  readonly asset: 'sol';
  readonly amountAtomic: string;
  readonly eventEpoch: string;
  readonly placedSignature: string;
  readonly placedInstructionIndex: number;
};

type PlacedEvent = {
  readonly signature: string;
  readonly instructionIndex: number;
  readonly marketId: string;
  readonly ownerPubkey: string;
  readonly lotNonce: string;
  readonly positionPda: string;
  readonly side: Side;
  readonly asset: 'sol';
  readonly amountAtomic: string;
  readonly eventEpoch: string;
};

type SigningSession = {
  readonly userId: number;
  readonly transactionSignature: string;
  readonly marketId: string;
  readonly ownerPubkey: string;
  readonly lotNonce: string;
  readonly side: Side;
  readonly asset: 'sol';
  readonly amountAtomic: string;
  readonly eventEpoch: string;
  readonly documentHashHex: string;
};

export async function canonicalGroupLeaderboardFallback(
  client: GroupPointsDbClient,
  groupId: number,
): Promise<readonly LeaderboardEntry[]> {
  const groupRows = await boundedQuery(
    client.from('groups')
      .select('id,points_started_at', { count: 'exact' })
      .eq('id', groupId)
      .limit(2),
    1,
    'group',
  );
  const group = groupRows[0];
  if (group === undefined) return [];
  const groupRow = record(OP, group);
  if (safeIntegerField(OP, groupRow, 'id') !== groupId) return contractFailure(OP, 'group_id');
  const pointsStartedAtMs = timestamp(groupRow.points_started_at, 'points_started_at');
  const marketRows = await boundedQuery(
    client.from('markets')
      .select('id,custody_mode,is_replay,currency,status', { count: 'exact' })
      .eq('group_id', groupId)
      .eq('is_replay', false)
      .eq('currency', 'sol')
      .eq('status', 'settled')
      .limit(MAX_MARKETS + 1),
    MAX_MARKETS,
    'markets',
  );
  const markets = marketRows.map(parseMarket);
  const legacyIds = markets.filter((market) => market.custodyMode === 'legacy').map((market) => market.id);
  const escrowIds = markets.filter((market) => market.custodyMode === 'escrow').map((market) => market.id);
  const eligibleIds = markets.map((market) => market.id);
  const scoreEvents: ScoreEvent[] = [];
  let persistedEvents: readonly ScoreEvent[] = [];
  if (eligibleIds.length > 0) {
    const persistedRows = await boundedQuery(
      client.from('group_point_events')
        .select('market_id,user_id,side,result,points_delta,settled_at', { count: 'exact' })
        .eq('group_id', groupId)
        .in('market_id', eligibleIds)
        .limit(MAX_FACT_ROWS + 1),
      MAX_FACT_ROWS,
      'persisted_events',
    );
    persistedEvents = uniqueScoreEvents(persistedRows.map(parsePersistedEvent));
  }
  const legacySet = new Set(legacyIds);
  scoreEvents.push(...persistedEvents.filter((event) => legacySet.has(event.marketId)));

  if (escrowIds.length > 0) {
    const persistedByMarket = groupEvents(
      persistedEvents.filter((event) => !legacySet.has(event.marketId)),
    );
    const appliedRows = await boundedQuery(
      client.from('group_points_applied')
        .select('market_id,group_id', { count: 'exact' })
        .eq('group_id', groupId)
        .in('market_id', escrowIds)
        .limit(MAX_MARKETS + 1),
      MAX_MARKETS,
      'applied_markets',
    );
    const appliedIds = new Set(appliedRows.map((value) => parseAppliedMarket(value, groupId)));
    const deriveIds = escrowIds.filter(
      (marketId) => !persistedByMarket.has(marketId) && appliedIds.has(marketId),
    );
    const projectionIds = escrowIds.filter(
      (marketId) => persistedByMarket.has(marketId) || appliedIds.has(marketId),
    );
    const canonical = await canonicalEscrowProjection(
      client,
      projectionIds,
      deriveIds,
      pointsStartedAtMs,
    );
    const derivedByMarket = groupEvents(canonical.events);
    for (const marketId of escrowIds) {
      const persisted = persistedByMarket.get(marketId) ?? [];
      const derived = derivedByMarket.get(marketId) ?? [];
      const settlement = canonical.outcomes.get(marketId);
      if (persisted.length > 0) {
        if (settlement === undefined) return contractFailure(OP, 'persisted_settlement');
        for (const event of persisted) {
          const winningSide: Side = settlement.outcome === 'claim_won' ? 'back' : 'doubt';
          const expected: Result = event.side === winningSide ? 'won' : 'lost';
          if (event.result !== expected || event.settledAtMs !== settlement.settledAtMs) {
            return contractFailure(OP, 'persisted_event');
          }
        }
        scoreEvents.push(...persisted);
      } else {
        scoreEvents.push(...derived);
      }
    }
  }

  const events = uniqueScoreEvents(scoreEvents);
  const userIds = [...new Set(events.map((event) => event.userId))];
  if (userIds.length === 0) return [];
  if (userIds.length > MAX_USERS) return contractFailure(OP, 'users_bound');
  const userRows = await boundedQuery(
    client.from('users')
      .select('id,display_name,username', { count: 'exact' })
      .in('id', userIds)
      .limit(MAX_USERS + 1),
    MAX_USERS,
    'users',
  );
  const users = new Map<number, { readonly displayName: string; readonly username: string | null }>();
  for (const value of userRows) {
    const row = record(OP, value);
    const id = positiveIntegerField(OP, row, 'id');
    if (users.has(id)) return contractFailure(OP, 'user_id');
    users.set(id, {
      displayName: stringField(OP, row, 'display_name'),
      username: nullableStringField(OP, row, 'username'),
    });
  }

  const byUser = new Map<number, ScoreEvent[]>();
  for (const event of events) {
    const list = byUser.get(event.userId) ?? [];
    list.push(event);
    byUser.set(event.userId, list);
  }
  const entries: LeaderboardEntry[] = [];
  for (const [userId, history] of byUser) {
    const user = users.get(userId);
    if (user === undefined) return contractFailure(OP, 'user_id');
    history.sort(compareEvents);
    let wins = 0;
    let losses = 0;
    let currentStreak = 0;
    let bestStreak = 0;
    for (const event of history) {
      if (event.result === 'won') {
        wins += 1;
        currentStreak += 1;
        bestStreak = Math.max(bestStreak, currentStreak);
      } else {
        losses += 1;
        currentStreak = 0;
      }
    }
    const decisions = wins + losses;
    entries.push({
      group_id: groupId,
      user_id: userId,
      points: wins * 10,
      wins,
      losses,
      accuracy: decisions === 0 ? 0 : wins / decisions,
      current_streak: currentStreak,
      best_streak: bestStreak,
      display_name: user.displayName,
      username: user.username,
    });
  }
  entries.sort(compareLeaderboard);
  return entries;
}

async function canonicalEscrowProjection(
  client: GroupPointsDbClient,
  marketIds: readonly string[],
  deriveMarketIds: readonly string[],
  pointsStartedAtMs: number,
): Promise<CanonicalEscrowProjection> {
  const links = uniqueByMarket(
    (await boundedQuery(
      client.from('escrow_market_links')
        .select('market_id,program_id,document_hash_hex,chain_state,cluster,commitment,canonical,projection_stale', { count: 'exact' })
        .in('market_id', marketIds)
        .eq('cluster', 'devnet')
        .eq('commitment', 'finalized')
        .eq('canonical', true)
        .eq('projection_stale', false)
        .limit(MAX_MARKETS + 1),
      MAX_MARKETS,
      'links',
    )).map(parseLink),
    (value) => value.marketId,
    'market_link',
  );
  const settlements = uniqueByMarket(
    (await boundedQuery(
      client.from('settlements')
        .select('market_id,outcome,tier,settled_at', { count: 'exact' })
        .in('market_id', marketIds)
        .limit(MAX_MARKETS + 1),
      MAX_MARKETS,
      'settlements',
    )).map(parseSettlement),
    (value) => value.marketId,
    'settlement',
  );
  const chainSettlements = uniqueByMarket(
    (await boundedQuery(
      client.from('escrow_settlement_events')
        .select('market_id,program_id,document_hash_hex,outcome,block_time,observed_at,commitment,canonical', { count: 'exact' })
        .in('market_id', marketIds)
        .eq('commitment', 'finalized')
        .eq('canonical', true)
        .limit(MAX_MARKETS + 1),
      MAX_MARKETS,
      'settlement_events',
    )).map(parseChainSettlement),
    (value) => value.marketId,
    'chain_settlement',
  );
  const eligible = new Map<string, Settlement>();
  for (const marketId of marketIds) {
    const settlement = settlements.get(marketId);
    if (settlement === undefined) return contractFailure(OP, 'settlement');
    if (settlement.settledAtMs < pointsStartedAtMs) continue;
    if (settlement.tier === 'oracle_resolved') {
      // Persisted score events predate the chain-proven repair rule and remain
      // the canonical stats source. Only reconstruction from raw escrow facts
      // is restricted to chain-proven settlements below.
      eligible.set(marketId, settlement);
      continue;
    }
    const link = links.get(marketId);
    const chain = chainSettlements.get(marketId);
    if (link === undefined) return contractFailure(OP, 'market_link');
    if (chain === undefined) return contractFailure(OP, 'chain_settlement');
    if (settlement.outcome !== chain.outcome) return contractFailure(OP, 'settlement_outcome');
    if (link.programId !== chain.programId || link.documentHashHex !== chain.documentHashHex) {
      return contractFailure(OP, 'settlement_identity');
    }
    eligible.set(marketId, settlement);
  }
  if (eligible.size === 0) return { events: [], outcomes: eligible };
  const deriveSet = new Set(deriveMarketIds);
  const eligibleIds = [...eligible]
    .filter(([marketId, settlement]) => deriveSet.has(marketId) && settlement.tier === 'chain_proven')
    .map(([marketId]) => marketId);
  if (eligibleIds.length === 0) return { events: [], outcomes: eligible };
  const lotRows = await boundedQuery(
    client.from('escrow_position_lots')
      .select('market_id,owner_pubkey,lot_nonce,position_pda,side,asset,amount_atomic,event_epoch,state,placed_signature,placed_instruction_index,commitment,canonical', { count: 'exact' })
      .in('market_id', eligibleIds)
      .eq('commitment', 'finalized')
      .eq('canonical', true)
      .limit(MAX_FACT_ROWS + 1),
    MAX_FACT_ROWS,
    'lots',
  );
  const lots = lotRows.map(parseLot).filter((lot): lot is Lot => lot !== null);
  const accountRows = await boundedQuery(
    client.from('escrow_position_accounts')
      .select('market_id,owner_pubkey,position_pda,side,asset,deposited_atomic,commitment,canonical', { count: 'exact' })
      .in('market_id', eligibleIds)
      .eq('commitment', 'finalized')
      .eq('canonical', true)
      .limit(MAX_FACT_ROWS + 1),
    MAX_FACT_ROWS,
    'accounts',
  );
  const accounts = new Map<string, ReturnType<typeof parseAccount>>();
  for (const value of accountRows) {
    const account = parseAccount(value);
    const key = ownerKey(account.marketId, account.ownerPubkey);
    if (accounts.has(key)) return contractFailure(OP, 'position_account');
    accounts.set(key, account);
  }
  const placedRows = await boundedQuery(
    client.from('escrow_position_events')
      .select('signature,instruction_index,market_id,owner_pubkey,lot_nonce,position_pda,event_kind,side,asset,amount_atomic,event_epoch,commitment,canonical', { count: 'exact' })
      .in('market_id', eligibleIds)
      .eq('event_kind', 'placed')
      .eq('commitment', 'finalized')
      .eq('canonical', true)
      .limit(MAX_FACT_ROWS + 1),
    MAX_FACT_ROWS,
    'placed_events',
  );
  const placed = new Map<string, PlacedEvent>();
  for (const value of placedRows) {
    const event = parsePlacedEvent(value);
    const key = instructionKey(event.signature, event.instructionIndex);
    if (placed.has(key)) return contractFailure(OP, 'placed_event');
    placed.set(key, event);
  }
  const sessionRows = await boundedQuery(
    client.from('escrow_signing_sessions')
      .select('user_id,transaction_signature,market_id,owner_pubkey,lot_nonce,side,asset,amount_atomic,event_epoch,document_hash_hex,state,consumed_at', { count: 'exact' })
      .in('market_id', eligibleIds)
      .eq('state', 'consumed')
      .limit(MAX_FACT_ROWS + 1),
    MAX_FACT_ROWS,
    'signing_sessions',
  );
  const sessions = sessionRows.map(parseSigningSession);
  const sessionsByLot = new Map<string, Set<number>>();
  for (const session of sessions) {
    const key = signingKey(session);
    const users = sessionsByLot.get(key) ?? new Set<number>();
    users.add(session.userId);
    sessionsByLot.set(key, users);
  }
  const result: ScoreEvent[] = [];
  const sides = new Map<string, Side>();
  const seen = new Set<string>();
  for (const lot of lots) {
    const link = links.get(lot.marketId);
    const chain = eligible.get(lot.marketId);
    if (link === undefined || chain === undefined) return contractFailure(OP, 'derived_market');
    const account = accounts.get(ownerKey(lot.marketId, lot.ownerPubkey));
    if (
      account === undefined || account.positionPda !== lot.positionPda ||
      account.side !== lot.side || account.asset !== lot.asset || account.depositedAtomic === '0'
    ) return contractFailure(OP, 'position_account');
    const placedEvent = placed.get(instructionKey(lot.placedSignature, lot.placedInstructionIndex));
    if (placedEvent === undefined || !samePlacedLot(placedEvent, lot)) {
      return contractFailure(OP, 'placed_event');
    }
    const identities = sessionsByLot.get(lotSigningKey(lot, link.documentHashHex));
    if (identities === undefined || identities.size === 0) {
      return contractFailure(OP, 'signing_identity');
    }
    if (identities.size !== 1) return contractFailure(OP, 'signing_identity');
    const userId = identities.values().next().value;
    if (userId === undefined) return contractFailure(OP, 'signing_identity');
    const marketUser = `${lot.marketId}:${userId}`;
    const existingSide = sides.get(marketUser);
    if (existingSide !== undefined && existingSide !== lot.side) {
      return contractFailure(OP, 'position_conflict');
    }
    sides.set(marketUser, lot.side);
    if (seen.has(marketUser)) continue;
    seen.add(marketUser);
    const winningSide: Side = chain.outcome === 'claim_won' ? 'back' : 'doubt';
    result.push({
      marketId: lot.marketId,
      userId,
      side: lot.side,
      result: lot.side === winningSide ? 'won' : 'lost',
      settledAtMs: chain.settledAtMs,
    });
  }
  return { events: result, outcomes: eligible };
}

async function boundedQuery(
  query: PromiseLike<unknown>,
  maximum: number,
  field: string,
): Promise<readonly unknown[]> {
  const response = await query;
  const count = exactCount(response, field);
  if (count > maximum) return contractFailure(OP, `${field}_bound`);
  const values = rows(OP, response);
  if (values.length !== count) return contractFailure(OP, `${field}_truncated`);
  if (values.length > maximum) return contractFailure(OP, `${field}_bound`);
  return values;
}

function exactCount(value: unknown, field: string): number {
  if (typeof value !== 'object' || value === null || !('count' in value)) {
    return contractFailure(OP, `${field}_count`);
  }
  const count = value.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    return contractFailure(OP, `${field}_count`);
  }
  return count;
}

function parseMarket(value: unknown): Market {
  const row = record(OP, value);
  if (booleanField(OP, row, 'is_replay') || stringField(OP, row, 'currency') !== 'sol' || stringField(OP, row, 'status') !== 'settled') {
    return contractFailure(OP, 'market');
  }
  const custodyMode = stringField(OP, row, 'custody_mode');
  if (custodyMode !== 'legacy' && custodyMode !== 'escrow') return contractFailure(OP, 'custody_mode');
  return { id: stringField(OP, row, 'id'), custodyMode };
}

function parseAppliedMarket(value: unknown, groupId: number): string {
  const row = record(OP, value);
  if (safeIntegerField(OP, row, 'group_id') !== groupId) {
    return contractFailure(OP, 'applied_group_id');
  }
  return stringField(OP, row, 'market_id');
}

function parsePersistedEvent(value: unknown): ScoreEvent {
  const row = record(OP, value);
  const result = parseResult(row.result);
  const points = safeIntegerField(OP, row, 'points_delta');
  if ((result === 'won' ? 10 : 0) !== points) return contractFailure(OP, 'points_delta');
  return {
    marketId: stringField(OP, row, 'market_id'),
    userId: positiveIntegerField(OP, row, 'user_id'),
    side: side(row.side),
    result,
    settledAtMs: timestamp(row.settled_at, 'settled_at'),
  };
}

function parseLink(value: unknown): Link {
  const row = record(OP, value);
  if (
    stringField(OP, row, 'cluster') !== 'devnet' || stringField(OP, row, 'commitment') !== 'finalized' ||
    !booleanField(OP, row, 'canonical') || booleanField(OP, row, 'projection_stale') ||
    !['settled', 'closed'].includes(stringField(OP, row, 'chain_state'))
  ) return contractFailure(OP, 'market_link');
  return {
    marketId: stringField(OP, row, 'market_id'),
    programId: stringField(OP, row, 'program_id'),
    documentHashHex: normalizedHash(row.document_hash_hex, 'document_hash_hex'),
  };
}

function parseSettlement(value: unknown): Settlement {
  const row = record(OP, value);
  const tier = stringField(OP, row, 'tier');
  if (tier !== 'chain_proven' && tier !== 'oracle_resolved') {
    return contractFailure(OP, 'settlement_tier');
  }
  return {
    marketId: stringField(OP, row, 'market_id'),
    outcome: parseOutcome(row.outcome),
    tier,
    settledAtMs: timestamp(row.settled_at, 'settled_at'),
  };
}

function parseChainSettlement(value: unknown): ChainSettlement {
  const row = record(OP, value);
  if (stringField(OP, row, 'commitment') !== 'finalized' || !booleanField(OP, row, 'canonical')) {
    return contractFailure(OP, 'chain_settlement');
  }
  const time = row.block_time === null ? row.observed_at : row.block_time;
  timestamp(time, 'settlement_time');
  return {
    marketId: stringField(OP, row, 'market_id'),
    outcome: parseOutcome(row.outcome),
    programId: stringField(OP, row, 'program_id'),
    documentHashHex: normalizedHash(row.document_hash_hex, 'document_hash_hex'),
  };
}

function parseLot(value: unknown): Lot | null {
  const row = record(OP, value);
  if (stringField(OP, row, 'commitment') !== 'finalized' || !booleanField(OP, row, 'canonical')) {
    return contractFailure(OP, 'lot_finality');
  }
  const state = stringField(OP, row, 'state');
  if (state === 'pending' || state === 'invalidated') return null;
  if (!['active', 'refundable', 'claimed'].includes(state)) return contractFailure(OP, 'lot_state');
  return {
    marketId: stringField(OP, row, 'market_id'), ownerPubkey: stringField(OP, row, 'owner_pubkey'),
    lotNonce: scalar(row.lot_nonce, 'lot_nonce'), positionPda: stringField(OP, row, 'position_pda'),
    side: side(row.side), asset: sol(row.asset), amountAtomic: positiveScalar(row.amount_atomic, 'amount_atomic'),
    eventEpoch: scalar(row.event_epoch, 'event_epoch'), placedSignature: stringField(OP, row, 'placed_signature'),
    placedInstructionIndex: safeIntegerField(OP, row, 'placed_instruction_index'),
  };
}

function parseAccount(value: unknown) {
  const row = record(OP, value);
  if (stringField(OP, row, 'commitment') !== 'finalized' || !booleanField(OP, row, 'canonical')) {
    return contractFailure(OP, 'account_finality');
  }
  return {
    marketId: stringField(OP, row, 'market_id'), ownerPubkey: stringField(OP, row, 'owner_pubkey'),
    positionPda: stringField(OP, row, 'position_pda'), side: side(row.side), asset: sol(row.asset),
    depositedAtomic: scalar(row.deposited_atomic, 'deposited_atomic'),
  };
}

function parsePlacedEvent(value: unknown): PlacedEvent {
  const row = record(OP, value);
  if (
    stringField(OP, row, 'event_kind') !== 'placed' || stringField(OP, row, 'commitment') !== 'finalized' ||
    !booleanField(OP, row, 'canonical')
  ) return contractFailure(OP, 'placed_event');
  return {
    signature: stringField(OP, row, 'signature'), instructionIndex: safeIntegerField(OP, row, 'instruction_index'),
    marketId: stringField(OP, row, 'market_id'), ownerPubkey: stringField(OP, row, 'owner_pubkey'),
    lotNonce: scalar(row.lot_nonce, 'lot_nonce'), positionPda: stringField(OP, row, 'position_pda'),
    side: side(row.side), asset: sol(row.asset), amountAtomic: positiveScalar(row.amount_atomic, 'amount_atomic'),
    eventEpoch: scalar(row.event_epoch, 'event_epoch'),
  };
}

function parseSigningSession(value: unknown): SigningSession {
  const row = record(OP, value);
  if (stringField(OP, row, 'state') !== 'consumed') return contractFailure(OP, 'signing_state');
  timestamp(row.consumed_at, 'consumed_at');
  return {
    userId: positiveIntegerField(OP, row, 'user_id'), transactionSignature: stringField(OP, row, 'transaction_signature'),
    marketId: stringField(OP, row, 'market_id'), ownerPubkey: stringField(OP, row, 'owner_pubkey'),
    lotNonce: scalar(row.lot_nonce, 'lot_nonce'), side: side(row.side), asset: sol(row.asset),
    amountAtomic: positiveScalar(row.amount_atomic, 'amount_atomic'), eventEpoch: scalar(row.event_epoch, 'event_epoch'),
    documentHashHex: normalizedHash(row.document_hash_hex, 'document_hash_hex'),
  };
}

function samePlacedLot(event: PlacedEvent, lot: Lot): boolean {
  return event.marketId === lot.marketId && event.ownerPubkey === lot.ownerPubkey &&
    event.lotNonce === lot.lotNonce && event.positionPda === lot.positionPda && event.side === lot.side &&
    event.asset === lot.asset && event.amountAtomic === lot.amountAtomic && event.eventEpoch === lot.eventEpoch;
}

function signingKey(session: SigningSession): string {
  return [
    session.transactionSignature, session.marketId, session.ownerPubkey, session.lotNonce,
    session.side, session.asset, session.amountAtomic, session.eventEpoch, session.documentHashHex,
  ].join(':');
}

function lotSigningKey(lot: Lot, documentHashHex: string): string {
  return [
    lot.placedSignature, lot.marketId, lot.ownerPubkey, lot.lotNonce, lot.side,
    lot.asset, lot.amountAtomic, lot.eventEpoch, documentHashHex,
  ].join(':');
}

function uniqueScoreEvents(values: readonly ScoreEvent[]): readonly ScoreEvent[] {
  const unique = new Map<string, ScoreEvent>();
  for (const value of values) {
    const key = `${value.marketId}:${value.userId}`;
    const existing = unique.get(key);
    if (existing !== undefined && (
      existing.side !== value.side || existing.result !== value.result ||
      existing.settledAtMs !== value.settledAtMs
    )) {
      return contractFailure(OP, 'score_event');
    }
    unique.set(key, value);
  }
  return [...unique.values()];
}

function groupEvents(values: readonly ScoreEvent[]): Map<string, ScoreEvent[]> {
  const result = new Map<string, ScoreEvent[]>();
  for (const value of values) {
    const list = result.get(value.marketId) ?? [];
    list.push(value);
    result.set(value.marketId, list);
  }
  return result;
}

function uniqueByMarket<T>(values: readonly T[], key: (value: T) => string, field: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (result.has(id)) return contractFailure(OP, field);
    result.set(id, value);
  }
  return result;
}

function parseOutcome(value: unknown): 'claim_won' | 'claim_lost' {
  if (value === 'claim_won' || value === 'claim_lost') return value;
  return contractFailure(OP, 'outcome');
}

function parseResult(value: unknown): Result {
  if (value === 'won' || value === 'lost') return value;
  return contractFailure(OP, 'result');
}

function side(value: unknown): Side {
  if (value === 'back' || value === 'doubt') return value;
  return contractFailure(OP, 'side');
}

function sol(value: unknown): 'sol' {
  if (value === 'sol') return value;
  return contractFailure(OP, 'asset');
}

function scalar(value: unknown, field: string): string {
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return contractFailure(OP, field);
}

function positiveScalar(value: unknown, field: string): string {
  const result = scalar(value, field);
  if (result === '0') return contractFailure(OP, field);
  return result;
}

function normalizedHash(value: unknown, field: string): string {
  if (typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  return contractFailure(OP, field);
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'string') return contractFailure(OP, field);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return contractFailure(OP, field);
  return milliseconds;
}

function ownerKey(marketId: string, ownerPubkey: string): string {
  return `${marketId}:${ownerPubkey}`;
}

function instructionKey(signature: string, instructionIndex: number): string {
  return `${signature}:${instructionIndex}`;
}

function compareEvents(left: ScoreEvent, right: ScoreEvent): number {
  return left.settledAtMs - right.settledAtMs || left.marketId.localeCompare(right.marketId);
}

function compareLeaderboard(left: LeaderboardEntry, right: LeaderboardEntry): number {
  return right.points - left.points || right.wins - left.wins || left.losses - right.losses || left.user_id - right.user_id;
}
