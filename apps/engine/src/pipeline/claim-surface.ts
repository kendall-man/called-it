/**
 * Single-message claim lifecycle (STAKE_LADDER_ENABLED): one evolving Telegram
 * message carries a claim from the consent gate through clarify, pricing,
 * offer card, stepper, and the settled board. "The first message you send is
 * the last, until the board."
 *
 * The pre-mint states (consent gate / reading shell / clarify options /
 * pricing skeleton) are edits of ONE message whose id lives here, keyed by
 * claimId. At mint the market card INHERITS this id (setMarketCardMessage), so
 * every later state (skeleton, offer, stepper, board) is an edit of the same
 * message via the durable card_tg_message_id — this store is only needed for
 * the pre-mint window.
 *
 * Deliberately in-process and NOT durable: on a restart the id is lost and the
 * flow falls back to today's fresh-post behavior for a claim still mid-consent.
 * No money, session, or position depends on it — only the visual surface.
 */

import type { Poster } from '../bot/poster.js';

export class ClaimSurfaceStore {
  private readonly messages = new Map<string, number>();

  /** Persist the surface message id posted for this claim (first post only). */
  remember(claimId: string, messageId: number): void {
    this.messages.set(claimId, messageId);
  }

  /** The surface message id for this claim, or undefined (never posted / lost on restart). */
  get(claimId: string): number | undefined {
    return this.messages.get(claimId);
  }

  /** Drop the entry once the market card owns the message, or the claim closes. */
  forget(claimId: string): void {
    this.messages.delete(claimId);
  }
}

/**
 * Edit a claim's pre-mint surface in place (urgent, so it jumps ahead of
 * narration). Returns true when the surface was known and the edit enqueued;
 * false when there is no tracked surface, so callers fall back to posting.
 * `claimId` doubles as the card-edit collapse key for the pre-mint window.
 */
export function editClaimSurface(
  poster: Poster,
  surface: ClaimSurfaceStore | undefined,
  claim: {
    readonly id: string;
    readonly group_id: number;
    readonly surface_tg_message_id?: number | null;
  },
  text: string,
  keyboard?: Parameters<Poster['editCard']>[4],
): boolean {
  if (surface === undefined) return false;
  const messageId = surface.get(claim.id) ?? claim.surface_tg_message_id ?? undefined;
  if (messageId === undefined) return false;
  // Rehydrate the in-process collapse key after a restart so clarification,
  // pricing, and expiry all keep editing the same authoritative surface.
  surface.remember(claim.id, messageId);
  poster.editCard(claim.group_id, claim.id, messageId, text, keyboard, { urgent: true });
  return true;
}

/**
 * Collapse a claim's surface to a one-line close (decline / expiry) with the
 * keyboard stripped, then forget it. No-op (returns false) when the surface is
 * untracked so the caller keeps today's keyboard-strip behavior.
 */
export function closeClaimSurface(
  poster: Poster,
  surface: ClaimSurfaceStore | undefined,
  claim: {
    readonly id: string;
    readonly group_id: number;
    readonly surface_tg_message_id?: number | null;
  },
  text: string,
): boolean {
  let closed = editClaimSurface(poster, surface, claim, text);
  if (!closed && claim.surface_tg_message_id !== null && claim.surface_tg_message_id !== undefined) {
    poster.editCard(
      claim.group_id,
      claim.id,
      claim.surface_tg_message_id,
      text,
      undefined,
      { urgent: true },
    );
    closed = true;
  }
  if (closed) surface?.forget(claim.id);
  return closed;
}
