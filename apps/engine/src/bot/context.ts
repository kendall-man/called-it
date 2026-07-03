/**
 * Shared handler wiring: the bundle every bot handler receives, plus the
 * ensure-rows helpers (group/user/membership upserts + first-touch Rep seed).
 */

import type { User } from 'grammy/types';
import { TUNABLES } from '@calledit/market-engine';
import type { Deps, GroupRow } from '../ports.js';
import type { SendQueue } from './sendQueue.js';
import type { Poster } from './poster.js';
import type { Say } from './copy.js';
import type { IngestSupervisor } from '../ingest/supervisor.js';
import type { EntityCache } from './entities.js';
import type { LlmBudget } from './budget.js';

export interface HandlerCtx {
  deps: Deps;
  queue: SendQueue;
  poster: Poster;
  say: Say;
  supervisor: IngestSupervisor;
  entities: EntityCache;
  budget: LlmBudget;
}

export function displayName(user: Pick<User, 'first_name' | 'last_name'>): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Anon';
}

/** Upsert the user + membership; seed the starting balance on first touch. */
export async function ensureUserSeen(h: HandlerCtx, groupId: number, user: User): Promise<void> {
  await h.deps.db.upsertUser({
    id: user.id,
    display_name: displayName(user),
    username: user.username ?? null,
  });
  const { created } = await h.deps.db.ensureMembership(groupId, user.id);
  if (created) {
    await h.deps.db.postLedger({
      group_id: groupId,
      user_id: user.id,
      market_id: null,
      kind: 'seed',
      amount: TUNABLES.STARTING_BALANCE,
      idempotency_key: `seed:${groupId}:${user.id}`,
    });
    h.deps.log.info('member_seeded', { groupId, userId: user.id });
  }
}

/** Upsert the group row and (when present) the acting user. */
export async function ensureChatContext(
  h: HandlerCtx,
  chatId: number,
  chatTitle: string,
  user: User | undefined,
): Promise<GroupRow> {
  const group = await h.deps.db.upsertGroup({ id: chatId, title: chatTitle });
  if (user && !user.is_bot) await ensureUserSeen(h, chatId, user);
  return group;
}

export async function isGroupAdmin(
  h: HandlerCtx,
  getChatMember: () => Promise<{ status: string }>,
): Promise<boolean> {
  try {
    const member = await getChatMember();
    return member.status === 'administrator' || member.status === 'creator';
  } catch (err) {
    h.deps.log.warn('admin_check_failed', { error: String(err) });
    return false;
  }
}
