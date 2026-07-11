import { describe, expect, it } from 'vitest';
import {
  PUBLIC_GROUP_BOARD_SELECT,
  PUBLIC_RECEIPT_SELECT,
} from './queries';

describe('public query projections', () => {
  it('selects only the curated fields needed for public receipts', () => {
    expect(PUBLIC_RECEIPT_SELECT).toContain('merkle_proof');
    expect(PUBLIC_RECEIPT_SELECT).not.toMatch(
      /claimer|name|username|wallet|pubkey|validate_stat_tx|is_replay/i,
    );
  });

  it('keeps aggregate group-board reads free of participant identities', () => {
    expect(PUBLIC_GROUP_BOARD_SELECT).toContain('matched_amount_lamports');
    expect(PUBLIC_GROUP_BOARD_SELECT).toContain('paid_amount_lamports');
    expect(PUBLIC_GROUP_BOARD_SELECT).not.toMatch(
      /claimer|name|username|wallet|pubkey|quoted|position_id/i,
    );
  });
});
