import type { ServerResponse } from 'node:http';
import type { Deps, MarketRow } from '../ports.js';
import { describeTerms } from '../bot/cards.js';
import { computePots } from '../wager/pot.js';
import { formatSol } from '../wager/format.js';
import type { EngineApiOptions } from './server.js';
import { sendJson } from './server-http.js';

async function marketSummary(deps: Deps, market: MarketRow, webBaseUrl?: string) {
  const positions = await deps.db.positionsForMarket(market.id);
  const live = positions.filter((position) => position.state !== 'void');
  const pots = computePots(live, market.quote_probability);
  return {
    marketId: market.id,
    terms: describeTerms(market.spec),
    currency: 'sol',
    status: market.status,
    fixtureId: market.fixture_id,
    isReplay: market.is_replay,
    trustTier: market.spec.trustTier,
    probability: market.quote_probability,
    backers: live.filter((position) => position.side === 'back').length,
    doubters: live.filter((position) => position.side === 'doubt').length,
    forLamports: pots.forLamports.toString(),
    againstLamports: pots.againstLamports.toString(),
    forSol: formatSol(pots.forLamports),
    againstSol: formatSol(pots.againstLamports),
    matchedPct: pots.matchedPct,
    ...(webBaseUrl ? { receiptUrl: `${webBaseUrl}/r/${market.id}` } : {}),
  };
}

export async function handleSnapshot(
  options: EngineApiOptions,
  chatId: number,
  res: ServerResponse,
): Promise<void> {
  const group = await options.deps.db.getGroup(chatId);
  if (!group) {
    sendJson(res, 404, { error: 'unknown_group' });
    return;
  }
  const markets = await options.deps.db.openMarketsForGroup(chatId);
  sendJson(res, 200, {
    group: { id: group.id, title: group.title },
    markets: await Promise.all(
      markets.map((market) => marketSummary(options.deps, market)),
    ),
  });
}

export async function handleWallet(
  options: EngineApiOptions,
  chatId: number,
  userId: number,
  res: ServerResponse,
): Promise<void> {
  const { deps } = options;
  const wager = deps.wager;
  if (!wager) {
    sendJson(res, 503, { error: 'wager_unavailable' });
    return;
  }
  const { balanceLamports, pubkey } = await wager.walletSummary(userId);
  const open = await deps.db.openMarketsForGroup(chatId);
  const positions: Array<Record<string, unknown>> = [];
  for (const market of open) {
    const mine = (await deps.db.positionsForMarket(market.id)).filter(
      (position) => position.user_id === userId && position.state !== 'void',
    );
    for (const position of mine) {
      const stakeLamports = BigInt(position.stake);
      positions.push({
        marketId: market.id,
        terms: describeTerms(market.spec),
        side: position.side,
        stakeLamports: stakeLamports.toString(),
        stakeSol: formatSol(stakeLamports),
        state: position.state,
      });
    }
  }
  sendJson(res, 200, {
    linkedWallet: pubkey,
    balanceLamports: balanceLamports.toString(),
    balanceSol: formatSol(balanceLamports),
    positions,
  });
}

export async function handleMarket(
  options: EngineApiOptions,
  marketId: string,
  res: ServerResponse,
): Promise<void> {
  const market = await options.deps.db.getMarket(marketId);
  if (!market) {
    sendJson(res, 404, { error: 'unknown_market' });
    return;
  }
  sendJson(
    res,
    200,
    await marketSummary(options.deps, market, options.env.WEB_BASE_URL),
  );
}

export async function handleFixtures(
  options: EngineApiOptions,
  hours: number,
  res: ServerResponse,
): Promise<void> {
  const from = options.deps.now();
  const fixtures = await options.deps.db.fixturesBetween(
    from - 3 * 3_600_000,
    from + hours * 3_600_000,
  );
  sendJson(res, 200, {
    fixtures: fixtures.map((fixture) => ({
      fixtureId: fixture.fixture_id,
      home: fixture.p1_name,
      away: fixture.p2_name,
      kickoffAt: fixture.kickoff_at,
      phase: fixture.phase,
      minute: fixture.minute,
    })),
  });
}
