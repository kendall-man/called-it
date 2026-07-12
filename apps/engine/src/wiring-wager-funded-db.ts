import type { ProductionFundedWagerOptions } from './wiring-wager-funded.js';
import type { WagerModuleDeps } from './wager/module.js';

type WagerDb = WagerModuleDeps['db'];
type WrappedDbMethod =
  | 'markWithdrawalSubmitted'
  | 'markWithdrawalConfirmed'
  | 'markWithdrawalFailed'
  | 'insertSettlementApplied';
type SharedDbMethod =
  | 'positionsForMarket'
  | 'setPositionStates'
  | 'getCursor'
  | 'setCursor'
  | 'getUserName'
  | 'getUserNames'
  | 'tryCronLock'
  | 'releaseCronLock';

export interface PackageWagerDb extends Omit<WagerDb, WrappedDbMethod | SharedDbMethod> {
  markWithdrawalSubmitted(
    id: string,
    tx: { tx_sig: string; raw_tx_b64: string; last_valid_block_height: number },
  ): Promise<unknown>;
  markWithdrawalConfirmed(id: string): Promise<unknown>;
  markWithdrawalFailed(id: string, error: string): Promise<unknown>;
  insertSettlementApplied(marketId: string): Promise<unknown>;
}

export async function buildFundedWagerDb<Connection, Treasury, PublicKey>(
  options: ProductionFundedWagerOptions<Connection, Treasury, PublicKey>,
): Promise<WagerDb> {
  const { env, engineDb } = options;
  const wagerDb = await options.createDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const heldCronLocks = new Set<string>();
  return {
    ...wagerDb,
    async markWithdrawalSubmitted(id, tx) {
      await wagerDb.markWithdrawalSubmitted(id, tx);
    },
    async markWithdrawalConfirmed(id) {
      await wagerDb.markWithdrawalConfirmed(id);
    },
    async markWithdrawalFailed(id, error) {
      await wagerDb.markWithdrawalFailed(id, error);
    },
    async insertSettlementApplied(marketId) {
      await wagerDb.insertSettlementApplied(marketId);
    },
    positionsForMarket: (marketId) => engineDb.positionsForMarket(marketId),
    setPositionStates: (ids, state) => engineDb.setPositionStates(ids, state),
    getCursor: (streamName) => engineDb.getCursor(streamName),
    setCursor: (streamName, value) => engineDb.setCursor(streamName, value),
    getUserName: async (userId) => (await engineDb.getUser(userId))?.display_name ?? null,
    getUserNames(userIds) {
      if (engineDb.getUserNames === undefined) {
        throw new TypeError('engine database facade is missing getUserNames');
      }
      return engineDb.getUserNames(userIds);
    },
    async tryCronLock(name) {
      if (heldCronLocks.has(name)) return false;
      heldCronLocks.add(name);
      return true;
    },
    async releaseCronLock(name) {
      heldCronLocks.delete(name);
    },
  };
}
