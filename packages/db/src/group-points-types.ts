import type { PositionSide } from '@calledit/market-engine';

export type GroupPointsApplyErrorCode =
  | 'market_not_found'
  | 'settlement_missing'
  | 'position_conflict';

export type GroupPointsIneligibleReason =
  | 'pre_activation'
  | 'replay'
  | 'unsupported_market';

export type PositionState = 'pending' | 'active' | 'void';

export interface PositionRow {
  id: string;
  market_id: string;
  user_id: number;
  side: PositionSide;
  stake: number;
  locked_multiplier: number;
  locked_odds_message_id: string | null;
  locked_odds_ts: number | null;
  state: PositionState;
  placed_at_ms: number;
  created_at: string;
}

export interface PositionInsert {
  market_id: string;
  user_id: number;
  side: PositionSide;
  stake: number;
  locked_multiplier: number;
  locked_odds_message_id: string | null;
  locked_odds_ts: number | null;
  state: 'pending' | 'active';
  placed_at_ms: number;
}

export type ApplyGroupPointsResult =
  | {
      readonly ok: false;
      readonly code: GroupPointsApplyErrorCode;
    }
  | {
      readonly ok: true;
      readonly eligible: true;
      readonly duplicate: boolean;
      readonly reason: null;
      readonly group_id: number;
      readonly scored_count: number;
      readonly winner_count: number;
    }
  | {
      readonly ok: true;
      readonly eligible: false;
      readonly duplicate: boolean;
      readonly reason: GroupPointsIneligibleReason;
      readonly group_id: number;
      readonly scored_count: 0;
      readonly winner_count: 0;
    };

export type PointResult = {
  readonly group_id: number;
  readonly market_id: string;
  readonly user_id: number;
  readonly side: PositionSide;
  readonly result: 'won' | 'lost';
  readonly points_delta: 10 | 0;
  readonly display_name: string;
  readonly username: string | null;
};

export type GroupPlayerStats = {
  readonly group_id: number;
  readonly user_id: number;
  readonly points: number;
  readonly wins: number;
  readonly losses: number;
  readonly accuracy: number;
  readonly current_streak: number;
  readonly best_streak: number;
};

export type LeaderboardEntry = GroupPlayerStats & {
  readonly display_name: string;
  readonly username: string | null;
};

export type PositionParticipant = {
  readonly group_id: number;
  readonly market_id: string;
  readonly user_id: number;
  readonly side: PositionSide;
  readonly display_name: string;
  readonly username: string | null;
  readonly participant_count: number;
};
