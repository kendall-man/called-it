import { renderFallback } from './copy.js';
import type { BotGroupReadyMarkerResult } from '../ports.js';
import type { SolanaNetwork } from '../solana-network.js';

export const BOT_ONBOARDING_VERSION = 'calledit_v1' as const;

export interface GroupReadyMarkerStore {
  markGroupReady(input: {
    readonly groupId: number;
    readonly onboardingVersion: typeof BOT_ONBOARDING_VERSION;
  }): Promise<BotGroupReadyMarkerResult>;
}

export function groupReadyMarkerStore(input: {
  readonly markGroupReady?: GroupReadyMarkerStore['markGroupReady'];
}): GroupReadyMarkerStore {
  const markGroupReady = input.markGroupReady;
  if (markGroupReady === undefined) {
    throw new Error('bot group readiness store is unavailable');
  }
  return { markGroupReady };
}

export type GroupReadinessPlan =
  | { readonly kind: 'post_ready'; readonly text: string }
  | { readonly kind: 'already_ready' }
  | { readonly kind: 'rejected'; readonly code: 'invalid_input' | 'group_not_found' };

export function groupInstallUrl(botUsername: string): string {
  const url = new URL(`https://t.me/${encodeURIComponent(botUsername)}`);
  url.searchParams.set('startgroup', BOT_ONBOARDING_VERSION);
  url.searchParams.set('admin', 'manage_chat');
  return url.toString();
}

export function groupBoardUrl(webBaseUrl: string, groupSlug: string): string {
  const url = new URL(webBaseUrl);
  const basePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${basePath}/g/${encodeURIComponent(groupSlug)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function claimGroupReadiness(
  store: GroupReadyMarkerStore,
  groupId: number,
): Promise<BotGroupReadyMarkerResult> {
  return store.markGroupReady({ groupId, onboardingVersion: BOT_ONBOARDING_VERSION });
}

export function readyMessageForGroup(input: {
  readonly group: { readonly id: number; readonly slug: string };
  readonly webBaseUrl: string;
  readonly solanaNetwork?: SolanaNetwork;
}): string {
  return renderFallback('group_ready', {
    webUrl: groupBoardUrl(input.webBaseUrl, input.group.slug),
  }, input.solanaNetwork ?? 'devnet');
}

export async function planGroupReadiness(input: {
  readonly store: GroupReadyMarkerStore;
  readonly group: { readonly id: number; readonly slug: string };
  readonly webBaseUrl: string;
  readonly solanaNetwork?: SolanaNetwork;
}): Promise<GroupReadinessPlan> {
  const marker = await claimGroupReadiness(input.store, input.group.id);
  if (!marker.ok) return { kind: 'rejected', code: marker.code };
  if (!marker.created) return { kind: 'already_ready' };
  return {
    kind: 'post_ready',
    text: readyMessageForGroup(input),
  };
}
