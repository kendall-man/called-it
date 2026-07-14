import type { WagerCustodyMode } from './custody-mode.js';

export type MarketFinancialRoute = 'legacy_ledger' | 'escrow_chain';

export interface MarketCustodyIdentity {
  readonly marketId: string;
  readonly custodyMode: WagerCustodyMode;
}

export type MarketFinancialRouteCheck =
  | { readonly ok: true; readonly route: MarketFinancialRoute }
  | {
      readonly ok: false;
      readonly code: 'market_custody_mismatch';
      readonly expectedRoute: MarketFinancialRoute;
      readonly attemptedRoute: MarketFinancialRoute;
    };

export class MarketCustodyIsolationError extends Error {
  readonly name = 'MarketCustodyIsolationError';

  constructor(
    readonly marketId: string,
    readonly expectedRoute: MarketFinancialRoute,
    readonly attemptedRoute: MarketFinancialRoute,
  ) {
    super('market custody route rejected');
  }
}

export function financialRouteForMarket(market: MarketCustodyIdentity): MarketFinancialRoute {
  switch (market.custodyMode) {
    case 'legacy':
      return 'legacy_ledger';
    case 'escrow':
      return 'escrow_chain';
    default:
      throw new TypeError('market custody mode is invalid');
  }
}

export function checkMarketFinancialRoute(
  market: MarketCustodyIdentity,
  attemptedRoute: MarketFinancialRoute,
): MarketFinancialRouteCheck {
  const expectedRoute = financialRouteForMarket(market);
  return attemptedRoute === expectedRoute
    ? { ok: true, route: expectedRoute }
    : {
        ok: false,
        code: 'market_custody_mismatch',
        expectedRoute,
        attemptedRoute,
      };
}

export function assertMarketFinancialRoute(
  market: MarketCustodyIdentity,
  attemptedRoute: MarketFinancialRoute,
): void {
  const result = checkMarketFinancialRoute(market, attemptedRoute);
  if (!result.ok) {
    throw new MarketCustodyIsolationError(
      market.marketId,
      result.expectedRoute,
      result.attemptedRoute,
    );
  }
}

export interface LegacyBalanceRecoveryPolicy {
  readonly depositsEnabled: boolean;
  readonly newPositionsEnabled: boolean;
  readonly settlementEnabled: true;
  readonly refundsEnabled: true;
  readonly withdrawalsEnabled: true;
}

export function legacyBalanceRecoveryPolicy(
  custodyMode: WagerCustodyMode,
): LegacyBalanceRecoveryPolicy {
  const acceptingNewLegacyValue = custodyMode === 'legacy';
  return {
    depositsEnabled: acceptingNewLegacyValue,
    newPositionsEnabled: acceptingNewLegacyValue,
    settlementEnabled: true,
    refundsEnabled: true,
    withdrawalsEnabled: true,
  };
}
