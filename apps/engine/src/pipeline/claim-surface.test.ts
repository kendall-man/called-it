/**
 * The in-process surface store and its edit/close helpers. These back the
 * single-message lifecycle: pre-mint states edit ONE message, and decline /
 * expiry collapse it to a one-line close. Flag-off (no store) is a no-op so the
 * caller keeps today's separate-message behavior.
 */

import { describe, expect, it } from 'vitest';
import type { InlineKeyboard } from 'grammy';
import type { Poster } from '../bot/poster.js';
import { CLAIM_DECLINED_LINE, CLAIM_EXPIRED_LINE } from '../bot/cards.js';
import { ClaimSurfaceStore, closeClaimSurface, editClaimSurface } from './claim-surface.js';

interface RecordedEdit {
  readonly chatId: number;
  readonly collapseKey: string;
  readonly messageId: number;
  readonly text: string;
  readonly keyboard: InlineKeyboard | undefined;
  readonly urgent: boolean;
}

function recordingPoster(edits: RecordedEdit[]): Poster {
  return {
    post: () => undefined,
    editCard: (chatId, collapseKey, messageId, text, keyboard, options) => {
      edits.push({ chatId, collapseKey, messageId, text, keyboard, urgent: options?.urgent ?? false });
    },
    stripKeyboard: () => undefined,
    react: () => undefined,
    chatAction: () => undefined,
  };
}

const CLAIM = { id: 'claim-1', group_id: -100 };

describe('claim surface store', () => {
  it('remembers, returns, and forgets a surface message id', () => {
    const store = new ClaimSurfaceStore();
    expect(store.get('claim-1')).toBeUndefined();
    store.remember('claim-1', 500);
    expect(store.get('claim-1')).toBe(500);
    store.forget('claim-1');
    expect(store.get('claim-1')).toBeUndefined();
  });
});

describe('editClaimSurface', () => {
  it('edits the tracked surface urgently, keyed by claim id', () => {
    const edits: RecordedEdit[] = [];
    const store = new ClaimSurfaceStore();
    store.remember(CLAIM.id, 500);

    const edited = editClaimSurface(recordingPoster(edits), store, CLAIM, 'next state');
    expect(edited).toBe(true);
    expect(edits).toEqual([
      { chatId: -100, collapseKey: 'claim-1', messageId: 500, text: 'next state', keyboard: undefined, urgent: true },
    ]);
  });

  it('rehydrates the persisted surface after restart instead of posting a second message', () => {
    const edits: RecordedEdit[] = [];
    const store = new ClaimSurfaceStore();
    const persisted = { ...CLAIM, surface_tg_message_id: 713 };

    expect(editClaimSurface(recordingPoster(edits), store, persisted, 'clarify')).toBe(true);
    expect(store.get(CLAIM.id)).toBe(713);
    expect(edits).toEqual([{
      chatId: -100,
      collapseKey: 'claim-1',
      messageId: 713,
      text: 'clarify',
      keyboard: undefined,
      urgent: true,
    }]);
  });

  it('is a no-op (flag off) when there is no store, and when the claim is untracked', () => {
    const edits: RecordedEdit[] = [];
    expect(editClaimSurface(recordingPoster(edits), undefined, CLAIM, 'x')).toBe(false);
    expect(editClaimSurface(recordingPoster(edits), new ClaimSurfaceStore(), CLAIM, 'x')).toBe(false);
    expect(edits).toHaveLength(0);
  });
});

describe('closeClaimSurface', () => {
  it('collapses the surface to the decline close-line and forgets it', () => {
    const edits: RecordedEdit[] = [];
    const store = new ClaimSurfaceStore();
    store.remember(CLAIM.id, 500);

    const closed = closeClaimSurface(recordingPoster(edits), store, CLAIM, CLAIM_DECLINED_LINE);
    expect(closed).toBe(true);
    expect(edits[0]).toMatchObject({ messageId: 500, text: CLAIM_DECLINED_LINE, keyboard: undefined });
    expect(store.get(CLAIM.id)).toBeUndefined();
  });

  it('collapses the surface to the expiry close-line (the claim-TTL cron path)', () => {
    const edits: RecordedEdit[] = [];
    const store = new ClaimSurfaceStore();
    store.remember(CLAIM.id, 512);

    expect(closeClaimSurface(recordingPoster(edits), store, CLAIM, CLAIM_EXPIRED_LINE)).toBe(true);
    expect(edits[0]).toMatchObject({ messageId: 512, text: CLAIM_EXPIRED_LINE });
    expect(store.get(CLAIM.id)).toBeUndefined();
  });

  it('is a no-op (flag off) with no store', () => {
    const edits: RecordedEdit[] = [];
    expect(closeClaimSurface(recordingPoster(edits), undefined, CLAIM, CLAIM_EXPIRED_LINE)).toBe(false);
    expect(edits).toHaveLength(0);
  });

  it('closes the persisted canonical surface after an in-process store restart', () => {
    const edits: RecordedEdit[] = [];
    const persisted = { ...CLAIM, surface_tg_message_id: 713 };

    expect(closeClaimSurface(
      recordingPoster(edits),
      new ClaimSurfaceStore(),
      persisted,
      CLAIM_EXPIRED_LINE,
    )).toBe(true);
    expect(edits).toEqual([{
      chatId: -100,
      collapseKey: 'claim-1',
      messageId: 713,
      text: CLAIM_EXPIRED_LINE,
      keyboard: undefined,
      urgent: true,
    }]);
  });
});
