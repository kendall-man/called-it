import { EngineEnvironmentError, type Env } from './env.js';
import type { Logger } from './log.js';
import type { EngineDb } from './ports.js';
import type { PackageWagerDb } from './wiring-wager-funded-db.js';
import type {
  FundedWagerModule,
  WagerModuleDeps,
  WagerPoster,
} from './wager/module.js';
import { expectedGenesisHash } from './solana-network.js';
import type { SolanaNetwork } from './solana-network.js';

type FactoryResult<Value> = Value | Promise<Value>;
type WagerChain = WagerModuleDeps['chain'];

export interface SignatureStatus {
  readonly slot: number;
  readonly err: unknown;
  readonly confirmations?: number | null;
  readonly confirmationStatus?: string | null;
}

export interface RetryRpc {
  sendRawTransaction(raw: Buffer, options?: { skipPreflight?: boolean }): Promise<string>;
  getSignatureStatuses(
    signatures: string[],
    config?: { searchTransactionHistory?: boolean },
  ): Promise<{ value: (SignatureStatus | null)[] }>;
  getBlockHeight(commitment?: 'confirmed' | 'finalized'): Promise<number>;
}

export interface WagerChainRuntime<Connection, Treasury, PublicKey> {
  publicKey(treasury: Treasury): PublicKey;
  publicKeyAddress(publicKey: PublicKey): string;
  getBalance(connection: Connection, publicKey: PublicKey): Promise<number>;
  getUsdcBalance?(
    connection: Connection,
    publicKey: PublicKey,
    network: SolanaNetwork,
  ): Promise<bigint>;
  getGenesisHash(connection: Connection): Promise<string>;
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
  buildUsdcTransfer?(args: {
    from: Treasury;
    to: string;
    amountAtomic: bigint;
    network: SolanaNetwork;
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
  fetchIncomingSolTransfers?(
    connection: Connection,
    treasuryAddress: string,
    options: { untilSig?: string },
  ): ReturnType<WagerChain['fetchIncomingTransfers']>;
  fetchIncomingUsdcTransfers?(
    connection: Connection,
    treasuryAddress: string,
    network: SolanaNetwork,
    options: { untilSig?: string },
  ): ReturnType<WagerChain['fetchIncomingTransfers']>;
  fetchIncomingTransfers?(
    connection: Connection,
    treasuryAddress: string,
    options: { untilSig?: string },
  ): ReturnType<WagerChain['fetchIncomingTransfers']>;
}

export interface ProductionFundedWagerOptions<Connection, Treasury, PublicKey> {
  readonly env: Env;
  readonly log: Logger;
  readonly engineDb: EngineDb;
  readonly poster?: WagerPoster;
  readonly createDb: (
    url: string,
    serviceRoleKey: string,
  ) => FactoryResult<PackageWagerDb>;
  readonly createConnection: (rpcUrl: string) => Connection;
  readonly loadTreasury: (secret: string) => Treasury;
  readonly chainRuntime: WagerChainRuntime<Connection, Treasury, PublicKey>;
}

export async function createProductionFundedWagerModule<Connection, Treasury, PublicKey>(
  options: ProductionFundedWagerOptions<Connection, Treasury, PublicKey>,
): Promise<FundedWagerModule | null> {
  const { env, log, poster } = options;
  if (env.STARTER_GRANTS_ENABLED) {
    throw new EngineEnvironmentError(['STARTER_GRANTS_ENABLED']);
  }
  const treasurySecret = env.WAGER_TREASURY_KEYPAIR_B58;
  if (treasurySecret === undefined) {
    log.warn('wager_module_disabled', { reason: 'WAGER_TREASURY_KEYPAIR_B58 not set' });
    return null;
  }
  if (poster === undefined) {
    throw new TypeError('wager module requires a poster - pass one to createDeps');
  }
  const treasury = options.loadTreasury(treasurySecret);
  const connection = options.createConnection(env.SOLANA_RPC_URL);
  const genesisHash = await options.chainRuntime.retry(() =>
    options.chainRuntime.getGenesisHash(connection));
  if (genesisHash !== expectedGenesisHash(env.SOLANA_NETWORK)) {
    throw new EngineEnvironmentError(['SOLANA_NETWORK', 'SOLANA_RPC_URL']);
  }
  const [{ createWagerModule }, { buildFundedWagerDb }] = await Promise.all([
    import('./wager/module.js'),
    import('./wiring-wager-funded-db.js'),
  ]);
  return createWagerModule({
    runtimeMode: 'funded',
    solanaNetwork: env.SOLANA_NETWORK,
    db: await buildFundedWagerDb(options),
    chain: buildWagerChain(connection, treasury, env.SOLANA_NETWORK, options.chainRuntime),
    poster,
    log,
    now: () => Date.now(),
    opsChatId: parseOpsChatId(env.WAGER_OPS_CHAT_ID, log),
    walletMiniappEnabled: env.WALLET_MINIAPP_ENABLED,
    webBaseUrl: env.WEB_BASE_URL,
    stakeAcceptanceEnabled: env.STAKE_ACCEPTANCE_ENABLED,
  });
}

function buildWagerChain<Connection, Treasury, PublicKey>(
  connection: Connection,
  treasury: Treasury,
  network: SolanaNetwork,
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
    async treasuryBalance(asset) {
      try {
        const amountAtomic = asset === 'sol'
          ? BigInt(await runtime.retry(() => runtime.getBalance(connection, publicKey)))
          : await runtime.retry(() => {
              if (runtime.getUsdcBalance === undefined) {
                throw new Error('USDC balance adapter unavailable');
              }
              return runtime.getUsdcBalance(connection, publicKey, network);
            });
        return { ok: true, amountAtomic };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { ok: false, error: `get ${asset} balance: ${error.message}` };
      }
    },
    async buildTransfer({ asset, to, amountAtomic }) {
      let latest: { blockhash: string; lastValidBlockHeight: number };
      try {
        latest = await runtime.retry(() => runtime.getLatestBlockhash(connection));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { ok: false, error: `getLatestBlockhash: ${error.message}` };
      }
      const common = {
        from: treasury,
        to,
        recentBlockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      };
      const built = asset === 'sol'
        ? runtime.buildSolTransfer({ ...common, lamports: amountAtomic })
        : runtime.buildUsdcTransfer === undefined
          ? { ok: false as const, error: 'USDC transfer adapter unavailable' }
          : runtime.buildUsdcTransfer({ ...common, amountAtomic, network });
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
    fetchIncomingTransfers: ({ asset, untilSig }) => {
      const options = untilSig === null ? {} : { untilSig };
      if (asset === 'sol') {
        const scanner = runtime.fetchIncomingSolTransfers ?? runtime.fetchIncomingTransfers;
        return scanner === undefined
          ? Promise.resolve({ ok: false, error: 'SOL deposit scanner unavailable' })
          : scanner(connection, treasuryAddress, options);
      }
      return runtime.fetchIncomingUsdcTransfers === undefined
        ? Promise.resolve({ ok: false, error: 'USDC deposit scanner unavailable' })
        : runtime.fetchIncomingUsdcTransfers(connection, treasuryAddress, network, options);
    },
  };
}

function parseOpsChatId(raw: string | undefined, log: Logger): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    log.warn('wager_ops_chat_invalid', { reason: 'not_safe_integer' });
    return null;
  }
  return parsed;
}
