import type { Env } from './env.js';
import type { Logger } from './log.js';
import type { EngineDb } from './ports.js';
import type { WagerModule, WagerModuleDeps, WagerPoster } from './wager/module.js';

type WagerDb = WagerModuleDeps['db'];
type WagerChain = WagerModuleDeps['chain'];
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
  | 'tryCronLock'
  | 'releaseCronLock';

interface PackageWagerDb extends Omit<WagerDb, WrappedDbMethod | SharedDbMethod> {
  markWithdrawalSubmitted(
    id: string,
    tx: { tx_sig: string; raw_tx_b64: string; last_valid_block_height: number },
  ): Promise<unknown>;
  markWithdrawalConfirmed(id: string): Promise<unknown>;
  markWithdrawalFailed(id: string, error: string): Promise<unknown>;
  insertSettlementApplied(marketId: string): Promise<unknown>;
}

interface SignatureStatus {
  slot: number;
  err: unknown;
  confirmations?: number | null;
  confirmationStatus?: string | null;
}

interface RetryRpc {
  sendRawTransaction(raw: Buffer, options?: { skipPreflight?: boolean }): Promise<string>;
  getSignatureStatuses(
    signatures: string[],
    config?: { searchTransactionHistory?: boolean },
  ): Promise<{ value: (SignatureStatus | null)[] }>;
  getBlockHeight(commitment?: 'confirmed' | 'finalized'): Promise<number>;
}

interface WagerChainRuntime<Connection, Treasury, PublicKey> {
  publicKey(treasury: Treasury): PublicKey;
  publicKeyAddress(publicKey: PublicKey): string;
  getBalance(connection: Connection, publicKey: PublicKey): Promise<number>;
  getLatestBlockhash(
    connection: Connection,
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRawTransaction(
    connection: Connection,
    raw: Buffer,
    options?: { skipPreflight?: boolean },
  ): Promise<string>;
  getSignatureStatuses(
    connection: Connection,
    signatures: string[],
    config?: { searchTransactionHistory?: boolean },
  ): Promise<{ value: (SignatureStatus | null)[] }>;
  getBlockHeight(
    connection: Connection,
    commitment?: 'confirmed' | 'finalized',
  ): Promise<number>;
  retry<Result>(operation: () => Promise<Result>): Promise<Result>;
  buildSolTransfer(args: {
    from: Treasury;
    to: string;
    lamports: bigint;
    recentBlockhash: string;
    lastValidBlockHeight: number;
  }):
    | { ok: true; rawTxB64: string; sig: string }
    | { ok: false; error: string };
  broadcastRawTx(rpc: RetryRpc, rawTxB64: string): ReturnType<WagerChain['broadcastRawTx']>;
  getSigStatus(rpc: RetryRpc, sig: string): ReturnType<WagerChain['getSigStatus']>;
  isBlockheightExceeded(
    rpc: RetryRpc,
    lastValidBlockHeight: number,
  ): ReturnType<WagerChain['isBlockheightExceeded']>;
  fetchIncomingTransfers(
    connection: Connection,
    treasuryAddress: string,
    options: { untilSig?: string },
  ): ReturnType<WagerChain['fetchIncomingTransfers']>;
}

export interface ProductionWagerOptions<Connection, Treasury, PublicKey> {
  env: Env;
  log: Logger;
  engineDb: EngineDb;
  poster?: WagerPoster;
  createDb(url: string, serviceRoleKey: string): PackageWagerDb;
  createConnection(rpcUrl: string): Connection;
  loadTreasury(secret: string): Treasury;
  chainRuntime: WagerChainRuntime<Connection, Treasury, PublicKey>;
}

export async function createProductionWagerModule<Connection, Treasury, PublicKey>(
  options: ProductionWagerOptions<Connection, Treasury, PublicKey>,
): Promise<WagerModule | null> {
  const { env, log, poster } = options;
  if (env.WAGER_MODE_ENABLED !== 'true') return null;
  const treasurySecret = env.WAGER_TREASURY_KEYPAIR_B58;
  if (treasurySecret === undefined) {
    log.warn('wager_module_disabled', { reason: 'WAGER_TREASURY_KEYPAIR_B58 not set' });
    return null;
  }
  if (poster === undefined) {
    throw new Error('wager module requires a poster - pass one to createDeps');
  }
  const treasury = options.loadTreasury(treasurySecret);
  const connection = options.createConnection(env.SOLANA_RPC_URL);
  const { createWagerModule } = await import('./wager/module.js');
  return createWagerModule({
    db: buildWagerDb(options),
    chain: buildWagerChain(connection, treasury, options.chainRuntime),
    poster,
    log,
    now: () => Date.now(),
    opsChatId: parseOpsChatId(env.WAGER_OPS_CHAT_ID, log),
  });
}

function buildWagerDb<Connection, Treasury, PublicKey>(
  options: ProductionWagerOptions<Connection, Treasury, PublicKey>,
): WagerDb {
  const { env, engineDb } = options;
  const wagerDb = options.createDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
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

function buildWagerChain<Connection, Treasury, PublicKey>(
  connection: Connection,
  treasury: Treasury,
  runtime: WagerChainRuntime<Connection, Treasury, PublicKey>,
): WagerChain {
  const publicKey = runtime.publicKey(treasury);
  const treasuryAddress = runtime.publicKeyAddress(publicKey);
  const retryRpc: RetryRpc = {
    sendRawTransaction: (raw, options) =>
      runtime.retry(() => runtime.sendRawTransaction(connection, raw, options)),
    getSignatureStatuses: (signatures, config) =>
      runtime.retry(() => runtime.getSignatureStatuses(connection, signatures, config)),
    getBlockHeight: (commitment) =>
      runtime.retry(() => runtime.getBlockHeight(connection, commitment)),
  };
  return {
    treasuryPubkey: () => treasuryAddress,
    async treasuryBalanceLamports() {
      try {
        const lamports = await runtime.retry(() => runtime.getBalance(connection, publicKey));
        return { ok: true, lamports: BigInt(lamports) };
      } catch (error) {
        return { ok: false, error: `getBalance: ${String(error)}` };
      }
    },
    async buildTransfer({ to, lamports }) {
      let latest: { blockhash: string; lastValidBlockHeight: number };
      try {
        latest = await runtime.retry(() => runtime.getLatestBlockhash(connection));
      } catch (error) {
        return { ok: false, error: `getLatestBlockhash: ${String(error)}` };
      }
      const built = runtime.buildSolTransfer({
        from: treasury,
        to,
        lamports,
        recentBlockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
      if (!built.ok) return { ok: false, error: built.error, permanent: true };
      return {
        ok: true,
        sig: built.sig,
        rawTxB64: built.rawTxB64,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      };
    },
    broadcastRawTx: (rawTxB64) => runtime.broadcastRawTx(retryRpc, rawTxB64),
    getSigStatus: (sig) => runtime.getSigStatus(retryRpc, sig),
    isBlockheightExceeded: (height) => runtime.isBlockheightExceeded(retryRpc, height),
    fetchIncomingTransfers: ({ untilSig }) =>
      runtime.fetchIncomingTransfers(connection, treasuryAddress, {
        ...(untilSig === null ? {} : { untilSig }),
      }),
  };
}

function parseOpsChatId(raw: string | undefined, log: Logger): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    log.warn('wager_ops_chat_invalid', { raw });
    return null;
  }
  return parsed;
}
