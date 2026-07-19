import type { Deps, MarketRow } from '../ports.js';
import type { EscrowMarketProvisioner } from '../escrow/market-provisioning.js';

const provisioners = new WeakMap<Deps, EscrowMarketProvisioner>();
// Keep the group-exclusive setup gate well inside the 45s replay grace window.
// Slow providers recover through the paused-card cron instead of holding every
// replay event behind a minute-long UI request.
const REPLAY_PROVISION_ATTEMPTS = 8;
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
  /** Presence hook: called once per replay poll attempt (1-based) so the caller can re-fire "typing". */
  onPollTick?: (attempt: number) => void,
): Promise<boolean> {
  if (deps.env.WAGER_CUSTODY_MODE !== 'escrow') return true;
  const provisioner = provisioners.get(deps);
  if (provisioner === undefined) return false;
  let failed = false;
  const ensure = async (): Promise<boolean> => {
    try {
      return await provisioner.ensure(market);
    } catch {
      failed = true;
      return false;
    }
  };

  if (await ensure()) return true;
  if (!market.is_replay) {
    if (failed) deps.log.error('escrow_market_provisioning_failed', { marketId: market.id });
    return false;
  }

  // The caller keeps the replay group lock while this polls. Do not release
  // it until the account and finalized projection are both ready, otherwise
  // accelerated historical events can overtake market initialization. A
  // transient RPC/initializer exception is the same not-ready boundary as a
  // queued account here: replay markets have no later paused-card recovery,
  // so aborting on the first exception would strand the card permanently.
  for (let attempt = 1; attempt < REPLAY_PROVISION_ATTEMPTS; attempt += 1) {
    await wait(REPLAY_PROVISION_POLL_MS);
    onPollTick?.(attempt);
    if (await ensure()) return true;
  }
  if (failed) deps.log.error('escrow_market_provisioning_failed', { marketId: market.id });
  return false;
}
