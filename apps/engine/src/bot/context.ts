/**
 * Shared handler wiring: the bundle every bot handler receives, plus the
 * ensure-rows helpers (group/user/membership upserts + first-touch Rep seed).
 */

import type { User } from 'grammy/types';
import type { Deps, GroupRow } from '../ports.js';
import { ensureMemberSeen } from '../pipeline/stake.js';
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
  await ensureMemberSeen(h.deps, groupId, {
    id: user.id,
    displayName: displayName(user),
    username: user.username ?? null,
  });
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
    h.deps.log.warn('admin_check_failed', {
      reason: err instanceof Error ? 'telegram_api_exception' : 'unknown_exception',
    });
    return false;
  }
}
