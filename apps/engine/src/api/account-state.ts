import type { ServerResponse } from 'node:http';
import { AccountPrincipalSchema, intentJson } from './account-protocol.js';
import type { AccountApiContext } from './account-api.js';
import { sendJson } from './server-http.js';

export async function handleAccountState(
  context: AccountApiContext,
  rawBody: unknown,
  res: ServerResponse,
): Promise<true> {
  const body = AccountPrincipalSchema.safeParse(rawBody);
  if (!body.success) {
    sendJson(res, 400, { error: 'bad_request' });
    return true;
  }
  if (!context.rateLimiter.allow({ operation: 'intent_read', principal: body.data })) {
    sendJson(res, 429, { error: 'rate_limited' });
    return true;
  }
  const wager = context.deps.wager;
  if (wager === null) {
    sendJson(res, 503, { error: 'wager_unavailable' });
    return true;
  }
  const [wallet, activeIntent] = await Promise.all([
    wager.walletSummary(body.data.userId),
    wager.account.resolveActiveStakeIntent(body.data.userId),
  ]);
  const intent = activeIntent.ok && Date.parse(activeIntent.intent.expires_at) > context.deps.now()
    ? intentJson(activeIntent.intent)
    : null;
  sendJson(res, 200, {
    wallet: { status: wallet.pubkey === null ? 'unlinked' : 'verified' },
    balanceLamports: wallet.balanceLamports.toString(),
    activeIntent: intent,
  });
  return true;
}
