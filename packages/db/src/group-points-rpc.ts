import type { GroupPointsDb, GroupPointsDbClient } from './group-points-contract.js';
import {
  booleanField,
  contractFailure,
  countField,
  exactKeys,
  record,
  responseData,
  safeIntegerField,
} from './group-points-parser-core.js';
import type { ApplyGroupPointsResult } from './types.js';

const APPLY_POINTS_OP = 'group_points_apply';
const APPLY_ERROR_KEYS = ['ok', 'code'] as const;
const APPLY_SUCCESS_KEYS = [
  'ok',
  'eligible',
  'duplicate',
  'reason',
  'group_id',
  'scored_count',
  'winner_count',
] as const;

type GroupPointsRpcDb = Pick<GroupPointsDb, 'applyGroupPoints'>;

export function groupPointsRpcMethods(client: GroupPointsDbClient): GroupPointsRpcDb {
  return {
    async applyGroupPoints(marketId) {
      const response = await client.rpc(APPLY_POINTS_OP, { p_market_id: marketId });
      const data = responseData(APPLY_POINTS_OP, response);
      if (data === null) return contractFailure(APPLY_POINTS_OP, '<payload>');
      return parseApplyGroupPoints(data);
    },
  } satisfies GroupPointsRpcDb;
}

function parseApplyGroupPoints(value: unknown): ApplyGroupPointsResult {
  const row = record(APPLY_POINTS_OP, value);
  if (row.ok === false) {
    exactKeys(APPLY_POINTS_OP, row, APPLY_ERROR_KEYS);
    return { ok: false, code: applyErrorCode(row.code) };
  }
  if (row.ok !== true) return contractFailure(APPLY_POINTS_OP, 'ok');
  exactKeys(APPLY_POINTS_OP, row, APPLY_SUCCESS_KEYS);

  const eligible = booleanField(APPLY_POINTS_OP, row, 'eligible');
  const duplicate = booleanField(APPLY_POINTS_OP, row, 'duplicate');
  const groupId = safeIntegerField(APPLY_POINTS_OP, row, 'group_id');
  const scoredCount = countField(APPLY_POINTS_OP, row, 'scored_count');
  const winnerCount = countField(APPLY_POINTS_OP, row, 'winner_count');
  if (winnerCount > scoredCount) return contractFailure(APPLY_POINTS_OP, 'winner_count');

  if (eligible) {
    if (row.reason !== null) return contractFailure(APPLY_POINTS_OP, 'reason');
    return {
      ok: true,
      eligible: true,
      duplicate,
      reason: null,
      group_id: groupId,
      scored_count: scoredCount,
      winner_count: winnerCount,
    };
  }

  const reason = ineligibleReason(row.reason);
  if (duplicate) return contractFailure(APPLY_POINTS_OP, 'duplicate');
  if (scoredCount !== 0 || winnerCount !== 0) {
    return contractFailure(APPLY_POINTS_OP, 'scored_count');
  }
  return {
    ok: true,
    eligible: false,
    duplicate,
    reason,
    group_id: groupId,
    scored_count: 0,
    winner_count: 0,
  };
}

function applyErrorCode(
  value: unknown,
): 'market_not_found' | 'settlement_missing' | 'position_conflict' {
  switch (value) {
    case 'market_not_found':
    case 'settlement_missing':
    case 'position_conflict':
      return value;
    default:
      return contractFailure(APPLY_POINTS_OP, 'code');
  }
}

function ineligibleReason(value: unknown): 'pre_activation' | 'replay' | 'unsupported_market' {
  switch (value) {
    case 'pre_activation':
    case 'replay':
    case 'unsupported_market':
      return value;
    default:
      return contractFailure(APPLY_POINTS_OP, 'reason');
  }
}
