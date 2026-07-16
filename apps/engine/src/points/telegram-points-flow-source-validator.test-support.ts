import type { PositionSide, SettlementOutcome } from '@calledit/market-engine';
import type {
  MarketRow,
  PositionRow,
  SettlementRow,
} from '../ports.js';
import type {
  ApplyGroupPointsResult,
  GroupPlayerStats,
  LeaderboardEntry,
  PointResult,
} from '../ports/rows.js';

type EligibleApply = Extract<ApplyGroupPointsResult, { readonly eligible: true }>;

export type PointSourceExpectation = {
  readonly groupId: number;
  readonly outcome: Exclude<SettlementOutcome, 'void'>;
  readonly taps: readonly {
    readonly userId: number;
    readonly side: PositionSide;
  }[];
};

export type PointTransition = {
  readonly source: PointSourceExpectation;
  readonly first: EligibleApply;
  readonly retry: EligibleApply;
  readonly results: readonly PointResult[];
  readonly stats: readonly GroupPlayerStats[];
  readonly leaderboard: readonly LeaderboardEntry[];
};

type FixtureFailure =
  | 'duplicate_configuration'
  | 'duplicate_source_tap'
  | 'duplicate_snapshot_event'
  | 'market_not_terminal'
  | 'market_group_mismatch'
  | 'settlement_mismatch'
  | 'tap_set_mismatch'
  | 'result_set_mismatch'
  | 'stats_set_mismatch'
  | 'apply_contract_mismatch';

export class PointFixtureMismatch extends Error {
  readonly name = 'PointFixtureMismatch';
  constructor(readonly marketId: string, readonly failure: FixtureFailure) {
    super(`Point fixture ${failure} for market ${marketId}`);
  }
}

function tapKey(userId: number, side: PositionSide): string {
  return `${userId}:${side}`;
}

function sorted(values: Iterable<string>): readonly string[] {
  return [...values].sort();
}

function equal(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function distinct(values: readonly string[]): ReadonlySet<string> {
  return new Set(values);
}

export function validatePointTransition(input: {
  readonly market: MarketRow;
  readonly settlement: SettlementRow | undefined;
  readonly positions: readonly PositionRow[];
  readonly transition: PointTransition;
}): void {
  const { market, settlement, positions, transition } = input;
  const source = transition.source;
  if (market.status !== 'settled') {
    throw new PointFixtureMismatch(market.id, 'market_not_terminal');
  }
  if (
    market.group_id !== source.groupId ||
    transition.first.group_id !== source.groupId ||
    transition.retry.group_id !== source.groupId
  ) {
    throw new PointFixtureMismatch(market.id, 'market_group_mismatch');
  }
  if (settlement === undefined || settlement.market_id !== market.id || settlement.outcome !== source.outcome) {
    throw new PointFixtureMismatch(market.id, 'settlement_mismatch');
  }
  if (transition.first.duplicate || !transition.retry.duplicate) {
    throw new PointFixtureMismatch(market.id, 'apply_contract_mismatch');
  }

  const expectedKeys = source.taps.map((tap) => tapKey(tap.userId, tap.side));
  const expectedUsers = source.taps.map((tap) => String(tap.userId));
  if (
    distinct(expectedKeys).size !== expectedKeys.length ||
    distinct(expectedUsers).size !== expectedUsers.length
  ) {
    throw new PointFixtureMismatch(market.id, 'duplicate_source_tap');
  }
  const activeKeys = distinct(
    positions
      .filter((position) => position.state === 'active')
      .map((position) => tapKey(position.user_id, position.side)),
  );
  if (!equal(sorted(activeKeys), sorted(expectedKeys))) {
    throw new PointFixtureMismatch(market.id, 'tap_set_mismatch');
  }

  const resultKeys = transition.results.map((result) => {
    if (result.market_id !== market.id || result.group_id !== source.groupId) return 'invalid';
    return tapKey(result.user_id, result.side);
  });
  if (distinct(resultKeys).size !== resultKeys.length) {
    throw new PointFixtureMismatch(market.id, 'duplicate_snapshot_event');
  }
  if (!equal(sorted(resultKeys), sorted(expectedKeys))) {
    throw new PointFixtureMismatch(market.id, 'result_set_mismatch');
  }

  const statsUsers = transition.stats.map((entry) => {
    return entry.group_id === source.groupId ? String(entry.user_id) : 'invalid';
  });
  if (!equal(sorted(distinct(statsUsers)), sorted(distinct(expectedUsers)))) {
    throw new PointFixtureMismatch(market.id, 'stats_set_mismatch');
  }
  if (transition.leaderboard.some((entry) => entry.group_id !== source.groupId)) {
    throw new PointFixtureMismatch(market.id, 'market_group_mismatch');
  }
}
