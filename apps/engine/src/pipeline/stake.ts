/**
 * Member bookkeeping shared by every handler: upsert the user row (needed for
 * display names, receipts, and wallet-link FKs) and record group membership.
 * There is no Rep seed anymore — the product stakes devnet SOL only, and funds
 * live in the wager ledger, not a per-group balance.
 */

import type { Deps } from '../ports.js';

export interface SeenUser {
  id: number;
  displayName: string;
  username: string | null;
}

/** Upsert the user + group membership. No starting balance — stakes are SOL. */
export async function ensureMemberSeen(
  deps: Deps,
  groupId: number,
  user: SeenUser,
): Promise<void> {
  await deps.db.upsertUser({
    id: user.id,
    display_name: user.displayName,
    username: user.username,
  });
  await deps.db.ensureMembership(groupId, user.id);
}
