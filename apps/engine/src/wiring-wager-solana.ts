import type {
  ProductionFundedWagerOptions,
  RetryRpc,
  SignatureStatus,
  WagerChainRuntime,
} from './wiring-wager-funded.js';
import type { WagerModuleDeps } from './wager/module.js';

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
    broadcastRawTx: (rpc, rawTxB64) => runtime.broadcastRawTx(rpc, rawTxB64),
    getSigStatus: (rpc, sig) => runtime.getSigStatus(rpc, sig),
    isBlockheightExceeded: (rpc, height) => runtime.isBlockheightExceeded(rpc, height),
    fetchIncomingTransfers: (connection, address, options) =>
      runtime.fetchIncomingTransfers(connection, address, options),
  };
  return {
    createConnection: (rpcUrl) => new runtime.Connection(rpcUrl, 'confirmed'),
    loadTreasury: (secret) => runtime.loadWallet(secret),
    chainRuntime,
  };
}
