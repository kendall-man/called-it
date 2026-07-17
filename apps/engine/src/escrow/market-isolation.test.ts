import { describe, expect, it } from 'vitest';
import {
  assertMarketFinancialRoute,
  checkMarketFinancialRoute,
  financialRouteForMarket,
  legacyBalanceRecoveryPolicy,
  type MarketCustodyIdentity,
} from './market-isolation.js';
import { evaluateMarketCreationRelease } from './release-control.js';
import type { EscrowReadinessReport } from './readiness.js';

const READY: EscrowReadinessReport = { status: 'ready', reasons: [] };
const NOT_READY: EscrowReadinessReport = {
  status: 'not_ready',
  reasons: ['program_not_executable'],
};

describe('legacy and escrow market isolation', () => {
  it.each([
    [{ marketId: 'legacy-market', custodyMode: 'legacy' }, 'legacy_ledger'],
    [{ marketId: 'escrow-market', custodyMode: 'escrow' }, 'escrow_chain'],
  ] as const)('routes a recorded market only through its custody path', (market, route) => {
    expect(financialRouteForMarket(market)).toBe(route);
    expect(checkMarketFinancialRoute(market, route)).toEqual({ ok: true, route });
  });

  it.each([
    [{ marketId: 'legacy-market', custodyMode: 'legacy' }, 'escrow_chain'],
    [{ marketId: 'escrow-market', custodyMode: 'escrow' }, 'legacy_ledger'],
  ] as const)('rejects cross-accounting instead of falling back', (market, attemptedRoute) => {
    const result = checkMarketFinancialRoute(market, attemptedRoute);

    expect(result).toEqual({
      ok: false,
      code: 'market_custody_mismatch',
      expectedRoute: financialRouteForMarket(market),
      attemptedRoute,
    });
    expect(() => assertMarketFinancialRoute(market, attemptedRoute)).toThrow(
      'market custody route rejected',
    );
  });

  it('keeps legacy balances withdrawable while escrow is selected for new markets', () => {
    expect(legacyBalanceRecoveryPolicy('escrow')).toEqual({
      depositsEnabled: false,
      newPositionsEnabled: false,
      settlementEnabled: true,
      refundsEnabled: true,
      withdrawalsEnabled: true,
    });
  });

  it('allows escrow only when the group, release gate, and readiness all pass', () => {
    expect(
      evaluateMarketCreationRelease({
        custodyMode: 'escrow',
        network: 'devnet',
        escrowGroupEnabled: true,
        mainnetEscrowEnabled: false,
        readiness: READY,
      }),
    ).toEqual({ kind: 'allowed', custodyMode: 'escrow', route: 'escrow_chain' });
  });

  it.each([
    {
      name: 'group not enabled',
      input: { network: 'devnet' as const, escrowGroupEnabled: false, readiness: READY },
      reason: 'group_not_enabled',
    },
    {
      name: 'deployment not ready',
      input: { network: 'devnet' as const, escrowGroupEnabled: true, readiness: NOT_READY },
      reason: 'escrow_not_ready',
    },
    {
      name: 'mainnet release disabled',
      input: {
        network: 'mainnet-beta' as const,
        escrowGroupEnabled: true,
        readiness: READY,
      },
      reason: 'mainnet_escrow_disabled',
    },
  ])('denies escrow for $name without a legacy fallback', ({ input, reason }) => {
    expect(
      evaluateMarketCreationRelease({
        custodyMode: 'escrow',
        mainnetEscrowEnabled: false,
        ...input,
      }),
    ).toEqual({ kind: 'denied', custodyMode: 'escrow', reason });
  });

  it('keeps explicitly selected legacy creation independent of escrow readiness', () => {
    expect(
      evaluateMarketCreationRelease({
        custodyMode: 'legacy',
        network: 'mainnet-beta',
        escrowGroupEnabled: false,
        mainnetEscrowEnabled: false,
        readiness: NOT_READY,
      }),
    ).toEqual({ kind: 'allowed', custodyMode: 'legacy', route: 'legacy_ledger' });
  });

  it('allows mainnet escrow only after its explicit release control is enabled', () => {
    expect(
      evaluateMarketCreationRelease({
        custodyMode: 'escrow',
        network: 'mainnet-beta',
        escrowGroupEnabled: true,
        mainnetEscrowEnabled: true,
        readiness: READY,
      }),
    ).toEqual({ kind: 'allowed', custodyMode: 'escrow', route: 'escrow_chain' });
  });

  it('requires a recorded custody mode for every existing market', () => {
    const malformed = { marketId: 'unknown-market' } as MarketCustodyIdentity;

    expect(() => financialRouteForMarket(malformed)).toThrow('market custody mode is invalid');
  });
});
