import type { Deps, EngineDb } from '../ports.js';
import type { LeaderboardPlayer, ParticipantIdentity } from './presentation.js';

const RECEIPT_LEADERBOARD_LIMIT = 5;
const RECEIPT_RESULTS_PER_OUTCOME_LIMIT = 10;

type GroupPointsDb = Pick<
  EngineDb,
  'applyGroupPoints' | 'pointResultsForMarket' | 'leaderboard'
>;

type GroupPointsLog = Pick<Deps['log'], 'info' | 'error'>;
type ApplyResult = Awaited<ReturnType<GroupPointsDb['applyGroupPoints']>>;
type PointProjection = Awaited<ReturnType<GroupPointsDb['pointResultsForMarket']>>[number];
type LeaderboardProjection = Awaited<ReturnType<GroupPointsDb['leaderboard']>>[number];
type IneligibleReason = Extract<
  ApplyResult,
  { readonly ok: true; readonly eligible: false }
>['reason'];

function safeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validIdentity(displayName: string, username: string | null): boolean {
  return typeof displayName === 'string' &&
    (username === null || typeof username === 'string');
}

function validPointProjection(
  row: PointProjection,
  marketId: string,
  groupId: number,
): boolean {
  const validResult = row.result === 'won'
    ? row.points_delta === 10
    : row.result === 'lost' && row.points_delta === 0;
  return row.group_id === groupId &&
    row.market_id === marketId &&
    Number.isSafeInteger(row.user_id) && row.user_id > 0 &&
    (row.side === 'back' || row.side === 'doubt') &&
    validResult && validIdentity(row.display_name, row.username);
}

function validLeaderboardProjection(row: LeaderboardProjection, groupId: number): boolean {
  return row.group_id === groupId &&
    Number.isSafeInteger(row.user_id) && row.user_id > 0 &&
    safeCount(row.points) && safeCount(row.wins) && safeCount(row.losses) &&
    validIdentity(row.display_name, row.username);
}

export type EligibleGroupPointsSummary = {
  readonly eligible: true;
  readonly duplicate: boolean;
  readonly marketId: string;
  readonly groupId: number;
  readonly scoredCount: number;
  readonly winnerCount: number;
  readonly winners: readonly ParticipantIdentity[];
  readonly misses: readonly ParticipantIdentity[];
  readonly leaderboard: readonly LeaderboardPlayer[];
};

export type IneligibleGroupPointsSummary = {
  readonly eligible: false;
  readonly duplicate: boolean;
  readonly marketId: string;
  readonly groupId: number;
  readonly reason: IneligibleReason;
};

export type GroupPointsSummary =
  | EligibleGroupPointsSummary
  | IneligibleGroupPointsSummary;

export interface GroupPointsService {
  apply(marketId: string): Promise<GroupPointsSummary>;
}

export class GroupPointsApplicationError extends Error {
  readonly name = 'GroupPointsApplicationError';

  constructor(
    readonly marketId: string,
    readonly failure: 'apply_rejected' | 'dependency_failure' | 'projection_mismatch',
    readonly cause: unknown = null,
  ) {
    super(`Group points ${failure} for market ${marketId}`);
  }
}

export function createGroupPointsService(deps: {
  readonly db: GroupPointsDb;
  readonly log: GroupPointsLog;
}): GroupPointsService {
  return {
    async apply(marketId) {
      let appliedCounts: {
        readonly groupId: number;
        readonly scoredCount: number;
        readonly winnerCount: number;
      } | null = null;
      try {
        const applied = await deps.db.applyGroupPoints(marketId);
        if (!applied.ok) {
          throw new GroupPointsApplicationError(marketId, 'apply_rejected');
        }
        appliedCounts = {
          groupId: applied.group_id,
          scoredCount: applied.scored_count,
          winnerCount: applied.winner_count,
        };
        if (!applied.eligible) {
          deps.log.info('group_points_ineligible', {
            marketId,
            ...appliedCounts,
          });
          return {
            eligible: false,
            duplicate: applied.duplicate,
            marketId,
            groupId: applied.group_id,
            reason: applied.reason,
          };
        }

        const results = await deps.db.pointResultsForMarket(marketId);
        const leaderboardRows = await deps.db.leaderboard(
          applied.group_id,
          RECEIPT_LEADERBOARD_LIMIT,
        );
        const winners: ParticipantIdentity[] = [];
        const misses: ParticipantIdentity[] = [];
        for (const row of results) {
          if (!validPointProjection(row, marketId, applied.group_id)) {
            throw new GroupPointsApplicationError(marketId, 'projection_mismatch');
          }
          const identity = { displayName: row.display_name, username: row.username };
          switch (row.result) {
            case 'won':
              winners.push(identity);
              break;
            case 'lost':
              misses.push(identity);
              break;
          }
        }
        const expectedWinners = Math.min(
          applied.winner_count,
          RECEIPT_RESULTS_PER_OUTCOME_LIMIT,
        );
        const expectedMisses = Math.min(
          applied.scored_count - applied.winner_count,
          RECEIPT_RESULTS_PER_OUTCOME_LIMIT,
        );
        if (
          !safeCount(applied.scored_count) ||
          !safeCount(applied.winner_count) ||
          applied.winner_count > applied.scored_count ||
          winners.length !== expectedWinners ||
          misses.length !== expectedMisses ||
          leaderboardRows.length > RECEIPT_LEADERBOARD_LIMIT ||
          !leaderboardRows.every((row) => validLeaderboardProjection(row, applied.group_id))
        ) {
          throw new GroupPointsApplicationError(marketId, 'projection_mismatch');
        }
        const leaderboard = leaderboardRows.map((row) => ({
          displayName: row.display_name,
          username: row.username,
          points: row.points,
          wins: row.wins,
          losses: row.losses,
        }));
        const event = applied.duplicate
          ? 'group_points_duplicate'
          : 'group_points_applied';
        deps.log.info(event, {
          marketId,
          ...appliedCounts,
        });
        return {
          eligible: true,
          duplicate: applied.duplicate,
          marketId,
          groupId: applied.group_id,
          scoredCount: applied.scored_count,
          winnerCount: applied.winner_count,
          winners,
          misses,
          leaderboard,
        };
      } catch (error) {
        deps.log.error('group_points_failed', {
          marketId,
          ...(appliedCounts ?? {}),
        });
        if (error instanceof GroupPointsApplicationError) {
          throw error;
        }
        throw new GroupPointsApplicationError(marketId, 'dependency_failure', error);
      }
    },
  };
}
