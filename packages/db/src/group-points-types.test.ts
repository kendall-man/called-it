import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, expectTypeOf, test } from 'vitest';
import type {
  ApplyGroupPointsResult as CanonicalApplyGroupPointsResult,
  GroupPlayerStats as CanonicalGroupPlayerStats,
  GroupPointsApplyErrorCode as CanonicalGroupPointsApplyErrorCode,
  GroupPointsIneligibleReason as CanonicalGroupPointsIneligibleReason,
  LeaderboardEntry as CanonicalLeaderboardEntry,
  PointResult as CanonicalPointResult,
  PositionInsert as CanonicalPositionInsert,
  PositionParticipant as CanonicalPositionParticipant,
  PositionRow as CanonicalPositionRow,
  PositionState as CanonicalPositionState,
} from './group-points-types.js';
import type {
  ApplyGroupPointsResult,
  GroupPlayerStats,
  GroupPointsApplyErrorCode,
  GroupPointsIneligibleReason,
  LeaderboardEntry,
  PointResult,
  PositionInsert,
  PositionParticipant,
  PositionRow,
  PositionState,
} from './index.js';

type CanonicalGroupPointsTypes = {
  readonly applyResult: CanonicalApplyGroupPointsResult;
  readonly applyErrorCode: CanonicalGroupPointsApplyErrorCode;
  readonly ineligibleReason: CanonicalGroupPointsIneligibleReason;
  readonly pointResult: CanonicalPointResult;
  readonly playerStats: CanonicalGroupPlayerStats;
  readonly leaderboardEntry: CanonicalLeaderboardEntry;
  readonly participant: CanonicalPositionParticipant;
  readonly positionState: CanonicalPositionState;
  readonly positionRow: CanonicalPositionRow;
  readonly positionInsert: CanonicalPositionInsert;
};

type PublicGroupPointsTypes = {
  readonly applyResult: ApplyGroupPointsResult;
  readonly applyErrorCode: GroupPointsApplyErrorCode;
  readonly ineligibleReason: GroupPointsIneligibleReason;
  readonly pointResult: PointResult;
  readonly playerStats: GroupPlayerStats;
  readonly leaderboardEntry: LeaderboardEntry;
  readonly participant: PositionParticipant;
  readonly positionState: PositionState;
  readonly positionRow: PositionRow;
  readonly positionInsert: PositionInsert;
};

test('keeps group-points types in a dedicated module with unchanged package exports', () => {
  // Given
  const modulePath = fileURLToPath(new URL('./group-points-types.ts', import.meta.url));

  // When
  const moduleExists = existsSync(modulePath);

  // Then
  expect(moduleExists).toBe(true);
  expectTypeOf<PublicGroupPointsTypes>().toEqualTypeOf<CanonicalGroupPointsTypes>();
});
