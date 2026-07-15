import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type Signer,
  type TransactionInstruction,
} from '@solana/web3.js';
import { AccountUnavailableError, ExpectedTransactionFailureMissingError, HarnessConfigurationError, ScenarioTimeoutError } from './errors.js';
import { isFinalizedSuccess } from './finalization.js';

export const COMMITMENT = 'finalized' as const;
const BLOCKHASH_COMMITMENT = 'processed' as const;

function parseSecretKey(value: unknown): Uint8Array {
  if (!Array.isArray(value) || value.length !== 64 || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new HarnessConfigurationError('Solana keypair file must contain exactly 64 byte values');
  }
  return Uint8Array.from(value);
}

export async function loadUpgradeAuthority(): Promise<Keypair> {
  const path = process.env['SOLANA_KEYPAIR_PATH'] ?? `${homedir()}/.config/solana/id.json`;
  const text = await readFile(path, 'utf8');
  return Keypair.fromSecretKey(parseSecretKey(JSON.parse(text)));
}

export function deterministicKeypair(label: string): Keypair {
  const seed = createHash('sha256').update(`calledit-local-validator:${label}`).digest().subarray(0, 32);
  return Keypair.fromSeed(seed);
}

export function connection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, { commitment: COMMITMENT, confirmTransactionInitialTimeout: 30_000 });
}

export async function sendInstructions(input: {
  readonly connection: Connection;
  readonly feePayer: Keypair;
  readonly instructions: readonly TransactionInstruction[];
  readonly signers?: readonly Signer[];
}): Promise<string> {
  const latest = await input.connection.getLatestBlockhash(BLOCKHASH_COMMITMENT);
  const transaction = new Transaction({ feePayer: input.feePayer.publicKey, ...latest });
  transaction.add(...input.instructions);
  transaction.sign(input.feePayer, ...(input.signers ?? []));
  return submitSignedTransactionBytes({
    connection: input.connection,
    signedBytes: transaction.serialize(),
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
}

export async function submitSignedTransactionBytes(input: {
  readonly connection: Connection;
  readonly signedBytes: Uint8Array;
  readonly lastValidBlockHeight: number;
  readonly timeoutMs?: number;
}): Promise<string> {
  const send = async (): Promise<string> => input.connection.sendRawTransaction(input.signedBytes, {
    maxRetries: 20,
    preflightCommitment: BLOCKHASH_COMMITMENT,
    skipPreflight: true,
  });
  const signature = await send();
  const deadline = Date.now() + (input.timeoutMs ?? 30_000);
  let lastBroadcast = Date.now();
  while (Date.now() < deadline) {
    const status = (await input.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })).value[0] ?? null;
    if (status?.err !== null && status?.err !== undefined) {
      throw new HarnessConfigurationError(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (isFinalizedSuccess(status)) return signature;
    const blockHeight = await input.connection.getBlockHeight(BLOCKHASH_COMMITMENT);
    if (blockHeight > input.lastValidBlockHeight) {
      throw new ScenarioTimeoutError(`transaction ${signature} expired before finalization`);
    }
    if (Date.now() - lastBroadcast >= 500) {
      try {
        const retried = await send();
        if (retried !== signature) throw new HarnessConfigurationError('exact-byte retry changed transaction signature');
      } catch (error) {
        if (!(error instanceof Error) || !/already been processed/i.test(error.message)) throw error;
      }
      lastBroadcast = Date.now();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new ScenarioTimeoutError(`finalized transaction ${signature}`);
}

export async function expectTransactionFailure(operation: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof HarnessConfigurationError && /^transaction .* failed:/.test(error.message)) return;
    throw error;
  }
  throw new ExpectedTransactionFailureMissingError(operation);
}

export async function accountData(connectionValue: Connection, address: PublicKey, owner?: PublicKey): Promise<Uint8Array> {
  const info = await connectionValue.getAccountInfo(address, COMMITMENT);
  if (info === null) throw new AccountUnavailableError(address.toBase58());
  if (owner !== undefined && !info.owner.equals(owner)) {
    throw new HarnessConfigurationError(`account ${address.toBase58()} has an unexpected owner`);
  }
  return info.data;
}

export async function chainTimestamp(connectionValue: Connection): Promise<bigint> {
  const slot = await connectionValue.getSlot(COMMITMENT);
  const timestamp = await connectionValue.getBlockTime(slot);
  if (timestamp === null) throw new HarnessConfigurationError('validator did not return a block timestamp');
  return BigInt(timestamp);
}

export async function waitUntil(input: {
  readonly operation: string;
  readonly timeoutMs: number;
  readonly predicate: () => Promise<boolean>;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (await input.predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  throw new ScenarioTimeoutError(input.operation);
}

export async function finalizedTransactionFee(connectionValue: Connection, signature: string): Promise<bigint> {
  const transaction = await connectionValue.getTransaction(signature, {
    commitment: COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
  if (transaction?.meta === null || transaction?.meta === undefined) {
    throw new HarnessConfigurationError(`finalized transaction metadata is unavailable for ${signature}`);
  }
  return BigInt(transaction.meta.fee);
}
