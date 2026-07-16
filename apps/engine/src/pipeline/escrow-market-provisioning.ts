import type { Deps, MarketRow } from '../ports.js';
import type { EscrowMarketProvisioner } from '../escrow/market-provisioning.js';

const provisioners = new WeakMap<Deps, EscrowMarketProvisioner>();
const REPLAY_PROVISION_ATTEMPTS = 40;
const REPLAY_PROVISION_POLL_MS = 1_500;

type Sleep = (milliseconds: number) => Promise<void>;

const sleep: Sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

export function registerEscrowMarketProvisioner(
  deps: Deps,
  provisioner: EscrowMarketProvisioner,
): void {
  provisioners.set(deps, provisioner);
}

export async function escrowMarketPositionsReady(
  deps: Deps,
  market: MarketRow,
  wait: Sleep = sleep,
): Promise<boolean> {
  if (deps.env.WAGER_CUSTODY_MODE !== 'escrow') return true;
  const provisioner = provisioners.get(deps);
  if (provisioner === undefined) return false;
  try {
    if (await provisioner.ensure(market)) return true;
    if (!market.is_replay) return false;

    // The caller keeps the replay group lock while this polls. Do not release
    // it until the account and finalized projection are both ready, otherwise
    // accelerated historical events can overtake market initialization.
    for (let attempt = 1; attempt < REPLAY_PROVISION_ATTEMPTS; attempt += 1) {
      await wait(REPLAY_PROVISION_POLL_MS);
      if (await provisioner.ensure(market)) return true;
    }
    return false;
  } catch (error) {
    deps.log.error('escrow_market_provisioning_failed', { marketId: market.id });
    return false;
  }
}
