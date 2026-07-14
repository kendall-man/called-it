import type {
  ProductionFundedWagerOptions,
  RetryRpc,
  SignatureStatus,
  WagerChainRuntime,
} from './wiring-wager-funded.js';
import type { WagerModuleDeps } from './wager/module.js';
import type { SolanaNetwork } from './solana-network.js';

type WagerChain = WagerModuleDeps['chain'];

interface SolanaPublicKey {
  toBase58(): string;
}

interface SolanaTreasury<PublicKey> {
  readonly publicKey: PublicKey;
}

interface SolanaConnection<PublicKey> {
  getGenesisHash(): Promise<string>;
  getBalance(publicKey: PublicKey, commitment: 'confirmed'): Promise<number>;
  getLatestBlockhash(
    commitment: 'finalized',
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRawTransaction(
    raw: Buffer,
    options?: { skipPreflight?: boolean },
  ): Promise<string>;
  getSignatureStatuses(
    signatures: string[],
    config?: { searchTransactionHistory?: boolean },
  ): Promise<{ value: (SignatureStatus | null)[] }>;
  getBlockHeight(commitment?: 'confirmed' | 'finalized'): Promise<number>;
}

interface RawDepositScan {
  readonly ok: boolean;
  readonly transfers?: readonly {
    readonly sig: string;
    readonly ixIndex: number;
    readonly sender: string;
    readonly lamports: bigint;
    readonly slot: number;
  }[];
  readonly newestSig?: string | null;
  readonly error?: string;
}

interface WagerSolanaModule<Connection, Treasury, PublicKey> {
  readonly Connection: new (rpcUrl: string, commitment: 'confirmed') => Connection;
  loadWallet(secret: string): Treasury;
  withRetry<Result>(operation: () => Promise<Result>): Promise<Result>;
  buildSolTransfer(args: {
    from: Treasury;
    to: string;
    lamports: bigint;
    recentBlockhash: string;
    lastValidBlockHeight: number;
  }):
    | { ok: true; rawTxB64: string; sig: string }
    | { ok: false; error: string };
  getUsdcBalance(
    connection: Connection,
    owner: string,
    network: SolanaNetwork,
  ): Promise<bigint>;
  buildUsdcTransfer(args: {
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
  fetchIncomingTransfers(
    connection: Connection,
    treasuryAddress: string,
    options: { untilSig?: string },
  ): Promise<RawDepositScan>;
  fetchIncomingTokenTransfers(
    connection: Connection,
    treasuryTokenAccount: string,
    mint: string,
    options: { untilSig?: string },
  ): Promise<RawDepositScan>;
  usdcAssociatedTokenAddress(owner: string, network: SolanaNetwork): PublicKey;
  usdcMintAddress(network: SolanaNetwork): PublicKey;
}

type FundedSolanaOptions<Connection, Treasury, PublicKey> = Pick<
  ProductionFundedWagerOptions<Connection, Treasury, PublicKey>,
  'chainRuntime' | 'createConnection' | 'loadTreasury'
>;

export function createWagerSolanaRuntime<
  PublicKey extends SolanaPublicKey,
  Connection extends SolanaConnection<PublicKey>,
  Treasury extends SolanaTreasury<PublicKey>,
>(
  runtime: WagerSolanaModule<Connection, Treasury, PublicKey>,
): FundedSolanaOptions<Connection, Treasury, PublicKey> {
  const chainRuntime: WagerChainRuntime<Connection, Treasury, PublicKey> = {
    publicKey: (treasury) => treasury.publicKey,
    publicKeyAddress: (publicKey) => publicKey.toBase58(),
    getGenesisHash: (connection) => connection.getGenesisHash(),
    getBalance: (connection, publicKey) => connection.getBalance(publicKey, 'confirmed'),
    getUsdcBalance: (connection, publicKey, network) =>
      runtime.getUsdcBalance(connection, publicKey.toBase58(), network),
    getLatestBlockhash: (connection) => connection.getLatestBlockhash('finalized'),
    sendRawTransaction: (connection, raw, options) =>
      connection.sendRawTransaction(raw, options),
    getSignatureStatuses: (connection, signatures, config) =>
      connection.getSignatureStatuses(signatures, {
        searchTransactionHistory: config?.searchTransactionHistory ?? false,
      }),
    getBlockHeight: (connection, commitment) => connection.getBlockHeight(commitment),
    retry: (operation) => runtime.withRetry(operation),
    buildSolTransfer: (args) => runtime.buildSolTransfer(args),
    buildUsdcTransfer: (args) => runtime.buildUsdcTransfer(args),
    broadcastRawTx: (rpc, rawTxB64) => runtime.broadcastRawTx(rpc, rawTxB64),
    getSigStatus: (rpc, sig) => runtime.getSigStatus(rpc, sig),
    isBlockheightExceeded: (rpc, height) => runtime.isBlockheightExceeded(rpc, height),
    async fetchIncomingSolTransfers(connection, address, options) {
      const scan = await runtime.fetchIncomingTransfers(connection, address, options);
      if (!scan.ok) return { ok: false, error: scan.error ?? 'SOL deposit scan failed' };
      return {
        ok: true,
        transfers: (scan.transfers ?? []).map((transfer) => ({
          ...transfer,
          asset: 'sol' as const,
          mintPubkey: null,
        })),
        newestSig: scan.newestSig ?? null,
      };
    },
    async fetchIncomingUsdcTransfers(connection, address, network, options) {
      const tokenAccount = runtime.usdcAssociatedTokenAddress(address, network).toBase58();
      const mint = runtime.usdcMintAddress(network).toBase58();
      const scan = await runtime.fetchIncomingTokenTransfers(connection, tokenAccount, mint, options);
      if (!scan.ok) return { ok: false, error: scan.error ?? 'USDC deposit scan failed' };
      return {
        ok: true,
        transfers: (scan.transfers ?? []).map((transfer) => ({
          ...transfer,
          asset: 'usdc' as const,
          mintPubkey: mint,
        })),
        newestSig: scan.newestSig ?? null,
      };
    },
  };
  return {
    createConnection: (rpcUrl) => new runtime.Connection(rpcUrl, 'confirmed'),
    loadTreasury: (secret) => runtime.loadWallet(secret),
    chainRuntime,
  };
}
