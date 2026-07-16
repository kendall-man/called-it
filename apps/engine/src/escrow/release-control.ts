import type { WagerCustodyMode } from './custody-mode.js';
import type { MarketFinancialRoute } from './market-isolation.js';
import type { EscrowNetwork, EscrowReadinessReport } from './readiness.js';

export type MarketCreationReleaseDecision =
  | {
      readonly kind: 'allowed';
      readonly custodyMode: WagerCustodyMode;
      readonly route: MarketFinancialRoute;
    }
  | {
      readonly kind: 'denied';
      readonly custodyMode: 'escrow';
      readonly reason: 'group_not_enabled' | 'mainnet_escrow_disabled' | 'escrow_not_ready';
    };

export function evaluateMarketCreationRelease(options: {
  readonly custodyMode: WagerCustodyMode;
  readonly network: EscrowNetwork;
  readonly escrowGroupEnabled: boolean;
  readonly mainnetEscrowEnabled: boolean;
  readonly readiness: EscrowReadinessReport;
}): MarketCreationReleaseDecision {
  if (options.custodyMode === 'legacy') {
    return { kind: 'allowed', custodyMode: 'legacy', route: 'legacy_ledger' };
  }
  if (!options.escrowGroupEnabled) {
    return { kind: 'denied', custodyMode: 'escrow', reason: 'group_not_enabled' };
  }
  if (options.network === 'mainnet-beta' && !options.mainnetEscrowEnabled) {
    return { kind: 'denied', custodyMode: 'escrow', reason: 'mainnet_escrow_disabled' };
  }
  if (options.readiness.status !== 'ready') {
    return { kind: 'denied', custodyMode: 'escrow', reason: 'escrow_not_ready' };
  }
  return { kind: 'allowed', custodyMode: 'escrow', route: 'escrow_chain' };
}
