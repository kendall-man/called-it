import {
  Connection,
  PublicKey,
  type AccountInfo,
  type SignatureStatus,
  type VersionedMessage,
} from '@solana/web3.js';
import { fail } from './errors.js';

export interface RecoveryAccountSnapshot {
  readonly slot: bigint;
  readonly accounts: readonly (AccountInfo<Buffer> | null)[];
}

export interface RecoveryRpc {
  genesisHash(): Promise<string>;
  accounts(addresses: readonly PublicKey[], minimumSlot?: bigint): Promise<RecoveryAccountSnapshot>;
  blockTime(slot: bigint): Promise<bigint>;
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
  blockHeight(): Promise<bigint>;
  blockhashValid(blockhash: string): Promise<boolean>;
  balance(address: PublicKey): Promise<bigint>;
  feeForMessage(message: VersionedMessage): Promise<bigint>;
  minimumTokenAccountRent(): Promise<bigint>;
  sendRawTransaction(bytes: Uint8Array): Promise<string>;
  signatureStatus(signature: string): Promise<SignatureStatus | null>;
}

export function createRecoveryRpc(rpcUrl: string): RecoveryRpc {
  const connection = new Connection(validateRpcUrl(rpcUrl), 'finalized');
  return {
    genesisHash: () => connection.getGenesisHash(),
    async accounts(addresses, minimumSlot) {
      const result = await connection.getMultipleAccountsInfoAndContext([...addresses], {
        commitment: 'finalized',
        ...(minimumSlot === undefined ? {} : { minContextSlot: safeNumber(minimumSlot, 'minimum slot') }),
      });
      return { slot: BigInt(result.context.slot), accounts: result.value };
    },
    async blockTime(slot) {
      const value = await connection.getBlockTime(safeNumber(slot, 'slot'));
      if (value === null) fail('rpc_unavailable', 'finalized block time is unavailable');
      return BigInt(value);
    },
    async latestBlockhash() {
      const value = await connection.getLatestBlockhash('finalized');
      return { blockhash: value.blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) };
    },
    blockHeight: async () => BigInt(await connection.getBlockHeight('finalized')),
    blockhashValid: (blockhash) => connection
      .isBlockhashValid(blockhash, { commitment: 'finalized' })
      .then((value) => value.value),
    balance: async (address) => BigInt(await connection.getBalance(address, 'finalized')),
    async feeForMessage(message) {
      const value = await connection.getFeeForMessage(message, 'finalized');
      if (value.value === null) fail('rpc_unavailable', 'transaction fee estimate is unavailable');
      return BigInt(value.value);
    },
    minimumTokenAccountRent: async () => BigInt(await connection.getMinimumBalanceForRentExemption(165, 'finalized')),
    sendRawTransaction: (bytes) => connection.sendRawTransaction(bytes, {
      maxRetries: 0,
      preflightCommitment: 'finalized',
      skipPreflight: false,
    }),
    signatureStatus: (signature) => connection
      .getSignatureStatus(signature, { searchTransactionHistory: true })
      .then((value) => value.value),
  };
}

function validateRpcUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('input_invalid', 'RPC endpoint must be a valid HTTP(S) URL');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    fail('input_invalid', 'RPC endpoint must be HTTP(S) without embedded credentials');
  }
  return value;
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('rpc_unavailable', `${label} exceeds the supported range`);
  }
  return Number(value);
}
