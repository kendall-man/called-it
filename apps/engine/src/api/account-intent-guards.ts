import type { MarketRow } from '../ports.js';
import type { PendingStakeIntentRow } from '../wager/port.js';
import type { AccountApiContext } from './account-api.js';
import type { GroupPrincipal } from './account-protocol.js';

export type IntentGuardResult =
  | { readonly ok: true; readonly intent: PendingStakeIntentRow }
  | { readonly ok: false; readonly error: string; readonly status: number };

export async function loadBoundIntent(
  context: AccountApiContext,
  principal: GroupPrincipal,
  intentId: string,
): Promise<IntentGuardResult> {
  const wager = context.deps.wager;
  if (wager === null) return { ok: false, error: 'wager_unavailable', status: 503 };
  const result = await wager.account.getPendingStakeIntent(principal.userId, intentId);
  if (!result.ok) return { ok: false, error: 'intent_not_found', status: 404 };
  if (result.intent.group_id !== principal.groupId) {
    return { ok: false, error: 'intent_group_mismatch', status: 403 };
  }
  if (isActiveIntent(result.intent) && Date.parse(result.intent.expires_at) <= context.deps.now()) {
    return { ok: false, error: 'intent_expired', status: 410 };
  }
  return { ok: true, intent: result.intent };
}

export async function requireOpenBoundMarket(
  context: AccountApiContext,
  intent: PendingStakeIntentRow,
): Promise<{ readonly ok: true; readonly market: MarketRow } | { readonly ok: false; readonly error: string; readonly status: number }> {
  const market = await context.deps.db.getMarket(intent.market_id);
  if (market === null) return { ok: false, error: 'market_not_found', status: 404 };
  if (market.group_id !== intent.group_id) {
    return { ok: false, error: 'market_group_mismatch', status: 409 };
  }
  if (market.status !== 'open' || market.currency !== 'sol') {
    return { ok: false, error: 'market_closed', status: 409 };
  }
  return { ok: true, market };
}

export async function requireOpenCreateMarket(
  context: AccountApiContext,
  principal: GroupPrincipal,
  marketId: string,
): Promise<{ readonly ok: true; readonly market: MarketRow } | { readonly ok: false; readonly error: string; readonly status: number }> {
  const group = await context.deps.db.getGroup(principal.groupId);
  if (group === null) return { ok: false, error: 'unknown_group', status: 404 };
  const market = await context.deps.db.getMarket(marketId);
  if (market === null) return { ok: false, error: 'market_not_found', status: 404 };
  if (market.group_id !== principal.groupId) {
    return { ok: false, error: 'market_group_mismatch', status: 403 };
  }
  if (market.status !== 'open' || market.currency !== 'sol') {
    return { ok: false, error: 'market_closed', status: 409 };
  }
  return { ok: true, market };
}

export function isActiveIntent(intent: PendingStakeIntentRow): boolean {
  return intent.state === 'pending' || intent.state === 'awaiting_funds' || intent.state === 'ready';
}
