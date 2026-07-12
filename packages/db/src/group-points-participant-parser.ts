import {
  contractFailure,
  countField,
  exactKeys,
  nullableStringField,
  positionSide,
  positiveIntegerField,
  record,
  safeIntegerField,
  stringField,
} from './group-points-parser-core.js';
import type { PositionParticipant } from './group-points-types.js';

const PARTICIPANT_OP = 'positionParticipantsForMarket';
const PARTICIPANT_KEYS = [
  'group_id',
  'market_id',
  'user_id',
  'side',
  'first_placed_at_ms',
  'display_name',
  'username',
  'participant_count',
] as const;
const PARTICIPANT_SIDE_LIMIT = 5;

type OrderedParticipant = {
  readonly participant: PositionParticipant;
  readonly placedAtMs: number;
};

type ParticipantSideState = {
  rows: number;
  total?: number;
};

export function parsePositionParticipants(
  values: readonly unknown[],
  marketId: string,
): readonly PositionParticipant[] {
  const parsed = values.map((value) => parseParticipant(value, marketId));
  const participants: PositionParticipant[] = [];
  const seen = new Set<string>();
  const sideState: Record<'back' | 'doubt', ParticipantSideState> = {
    back: { rows: 0 },
    doubt: { rows: 0 },
  };
  let groupId: number | undefined;
  let previous: OrderedParticipant | undefined;
  for (const current of parsed) {
    if (groupId === undefined) groupId = current.participant.group_id;
    if (current.participant.group_id !== groupId) {
      return contractFailure(PARTICIPANT_OP, 'group_id');
    }
    if (previous !== undefined && compareParticipants(previous, current) > 0) {
      return contractFailure(PARTICIPANT_OP, '<order>');
    }
    previous = current;
    const key = `${current.participant.user_id}:${current.participant.side}`;
    if (seen.has(key)) return contractFailure(PARTICIPANT_OP, 'user_id');
    seen.add(key);
    const state = sideState[current.participant.side];
    const total = current.participant.participant_count;
    if (total < 1 || (state.total !== undefined && state.total !== total)) {
      return contractFailure(PARTICIPANT_OP, 'participant_count');
    }
    state.total = total;
    state.rows += 1;
    if (state.rows > PARTICIPANT_SIDE_LIMIT) {
      return contractFailure(PARTICIPANT_OP, '<rows>');
    }
    participants.push(current.participant);
  }
  for (const state of Object.values(sideState)) {
    if (
      state.total !== undefined &&
      state.rows !== Math.min(state.total, PARTICIPANT_SIDE_LIMIT)
    ) {
      return contractFailure(PARTICIPANT_OP, 'participant_count');
    }
  }
  return participants;
}

function parseParticipant(value: unknown, marketId: string): OrderedParticipant {
  const row = record(PARTICIPANT_OP, value);
  exactKeys(PARTICIPANT_OP, row, PARTICIPANT_KEYS);
  const returnedMarketId = stringField(PARTICIPANT_OP, row, 'market_id');
  if (returnedMarketId !== marketId) return contractFailure(PARTICIPANT_OP, 'market_id');
  return {
    placedAtMs: countField(PARTICIPANT_OP, row, 'first_placed_at_ms'),
    participant: {
      group_id: safeIntegerField(PARTICIPANT_OP, row, 'group_id'),
      market_id: returnedMarketId,
      user_id: positiveIntegerField(PARTICIPANT_OP, row, 'user_id'),
      side: positionSide(PARTICIPANT_OP, row.side),
      display_name: stringField(PARTICIPANT_OP, row, 'display_name'),
      username: nullableStringField(PARTICIPANT_OP, row, 'username'),
      participant_count: countField(PARTICIPANT_OP, row, 'participant_count'),
    },
  };
}

function compareParticipants(left: OrderedParticipant, right: OrderedParticipant): number {
  if (left.placedAtMs !== right.placedAtMs) return left.placedAtMs - right.placedAtMs;
  if (left.participant.user_id !== right.participant.user_id) {
    return left.participant.user_id - right.participant.user_id;
  }
  return left.participant.side.localeCompare(right.participant.side);
}
