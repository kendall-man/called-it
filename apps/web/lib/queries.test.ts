import { describe, expect, it } from 'vitest';
import {
  PUBLIC_GROUP_BOARD_SELECT,
  PUBLIC_RECEIPT_SELECT,
} from './queries';

const PRIVATE_FIELD_TOKENS: ReadonlySet<string> = new Set([
  'accuracy',
  'alias',
  'claimer',
  'display',
  'leaderboard',
  'loss',
  'losses',
  'name',
  'participant',
  'participants',
  'player',
  'players',
  'point',
  'points',
  'position',
  'pubkey',
  'quoted',
  'rank',
  'result',
  'results',
  'score',
  'scores',
  'side',
  'streak',
  'telegram',
  'user',
  'username',
  'wallet',
  'win',
  'winner',
  'winners',
  'wins',
]);

const PUBLIC_AGGREGATE_FIELD_EXCEPTIONS: ReadonlySet<string> = new Set(['position_count']);

const PRIVATE_FIELD_MUTATIONS = [
  'name',
  'quoted',
  'participant_name',
  'winner_name',
  'telegram_user_id',
  'leaderboard_rank',
  'points',
  'total_points',
] as const;

function privateProjectionFields(select: string): readonly string[] {
  return select.split(',').filter((field) => {
    const normalized = field.trim().toLowerCase();
    if (PUBLIC_AGGREGATE_FIELD_EXCEPTIONS.has(normalized)) return false;
    return normalized.split('_').some((token) => PRIVATE_FIELD_TOKENS.has(token));
  });
}

describe('public query projections', () => {
  it('selects only the curated fields needed for public receipts', () => {
    expect(PUBLIC_RECEIPT_SELECT).toContain('merkle_proof');
    expect(privateProjectionFields(PUBLIC_RECEIPT_SELECT)).toEqual([]);
    expect(PUBLIC_RECEIPT_SELECT).not.toMatch(/validate_stat_tx|is_replay/i);
  });

  it('keeps aggregate group-board reads free of participant identities', () => {
    expect(PUBLIC_GROUP_BOARD_SELECT).toContain('matched_amount_lamports');
    expect(PUBLIC_GROUP_BOARD_SELECT).toContain('paid_amount_lamports');
    expect(privateProjectionFields(PUBLIC_GROUP_BOARD_SELECT)).toEqual([]);
  });

  it.each(PRIVATE_FIELD_MUTATIONS)('rejects the private projection field %s', (field) => {
    expect(privateProjectionFields(`market_id,${field}`)).toEqual([field]);
  });
});
