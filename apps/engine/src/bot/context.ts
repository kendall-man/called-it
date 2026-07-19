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
import type { EscrowTelegramPort } from './escrow-ux.js';
import type { EphemeralPort } from './ephemeral.js';
import type { UiStateStore } from './stake-ui-state.js';
import type { ClaimSurfaceStore } from '../pipeline/claim-surface.js';

/** In-process live probes backing the admin /status board. */
export interface EngineStatusProbes {
  /** Escrow runtime readiness snapshot; absent without the escrow runtime. */
  readonly escrowReadiness?: () => Promise<{
    readonly status: 'ready' | 'not_ready';
    readonly reasons: readonly string[];
  }>;
}

export type AdminEndMatchResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'scheduled'; readonly fixtureId: number; readonly marketCount: number };

/** Durable, group-scoped escape hatch for an active or interrupted test match. */
export interface ReplayAdminControl {
  endMatch(groupId: number): Promise<AdminEndMatchResult>;
}

export interface PublicGroupIntake {
  ensure(groupId: number): Promise<void>;
}

export interface HandlerCtx {
  deps: Deps;
  queue: SendQueue;
  poster: Poster;
  say: Say;
  supervisor: IngestSupervisor;
  entities: EntityCache;
  budget: LlmBudget;
  /** Optional until the escrow wiring wave binds identity and placement services. */
  escrow?: EscrowTelegramPort;
  /** Optional live-status probes for the admin /status board. */
  status?: EngineStatusProbes;
  /** Present only when the escrow replay recovery path is fully wired. */
  replayAdmin?: ReplayAdminControl;
  /** Creates the immutable escrow rollout binding for a newly seen public-beta group. */
  groupIntake?: PublicGroupIntake;
  /**
   * In-process two-step stake ladder visual state (STAKE_LADDER_ENABLED). Only
   * present when the flag is on; its absence is the single-tap flow.
   */
  uiState?: UiStateStore;
  /**
   * Per-user ephemeral group-message surface for the stake stepper
   * (STAKE_LADDER_ENABLED). Present only when the flag is on; its absence (or a
   * runtime failure) degrades the side tap to the per-user single-tap signing
   * path, never morphing the shared card.
   */
  ephemeral?: EphemeralPort;
  /**
   * In-process surface-message tracking for the single-message claim lifecycle
   * (STAKE_LADDER_ENABLED). Present only when the flag is on; its absence is
   * today's separate-message behavior (consent gate, options, and card are
   * distinct posts).
   */
  claimSurface?: ClaimSurfaceStore;
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
