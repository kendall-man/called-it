import type { Deps, MarketRow } from '../ports.js';
import type { EscrowMarketProvisioner } from '../escrow/market-provisioning.js';

const provisioners = new WeakMap<Deps, EscrowMarketProvisioner>();

export function registerEscrowMarketProvisioner(
  deps: Deps,
  provisioner: EscrowMarketProvisioner,
): void {
  provisioners.set(deps, provisioner);
}

export async function escrowMarketPositionsReady(deps: Deps, market: MarketRow): Promise<boolean> {
  if (deps.env.WAGER_CUSTODY_MODE !== 'escrow') return true;
  const provisioner = provisioners.get(deps);
  if (provisioner === undefined) return false;
  try {
    return await provisioner.ensure(market);
  } catch (error) {
    deps.log.error('escrow_market_provisioning_failed', { marketId: market.id });
    return false;
  }
}
