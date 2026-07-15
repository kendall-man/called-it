import { decodeEscrowEventLog, type EscrowProgramEvent } from '@calledit/escrow-sdk';
import {
  PublicKey,
  type ConfirmedSignatureInfo,
  type Connection,
  type SignaturesForAddressOptions,
} from '@solana/web3.js';
import type { EscrowEventProjector } from './event-projector.js';
import type {
  EscrowFinalizedCursor,
  EscrowFinalizedEvent,
  EscrowFinalizedEventSource,
  EscrowFinalizedTransaction,
} from './finalized-indexer.js';

export class EscrowFinalizedSourceError extends Error {
  readonly name = 'EscrowFinalizedSourceError';

  constructor(readonly code: 'network_mismatch' | 'backlog_limit_exceeded' | 'transaction_unavailable' | 'malformed_logs') {
    super(`escrow finalized source failed: ${code}`);
  }
}

interface LocatedEvent {
  readonly instructionIndex: number;
  readonly event: EscrowProgramEvent;
}

function eventLogs(logs: readonly string[], programId: string): readonly LocatedEvent[] {
  const stack: string[] = [];
  const events: LocatedEvent[] = [];
  let topLevelInstruction = -1;
  for (const log of logs) {
    const invocation = /^Program (\S+) invoke \[(\d+)]$/.exec(log);
    if (invocation !== null) {
      const invokedProgram = invocation[1];
      const depthText = invocation[2];
      if (invokedProgram === undefined || depthText === undefined) {
        throw new EscrowFinalizedSourceError('malformed_logs');
      }
      const depth = Number(depthText);
      if (!Number.isSafeInteger(depth) || depth < 1) {
        throw new EscrowFinalizedSourceError('malformed_logs');
      }
      if (depth === 1) topLevelInstruction += 1;
      stack.length = depth - 1;
      stack.push(invokedProgram);
      continue;
    }
    const completion = /^Program (\S+) (?:success|failed:.*)$/.exec(log);
    if (completion !== null) {
      if (stack.at(-1) === completion[1]) stack.pop();
      continue;
    }
    if (stack.at(-1) !== programId || !log.startsWith('Program data: ')) continue;
    const event = decodeEscrowEventLog(log);
    if (event !== null) events.push({ instructionIndex: topLevelInstruction, event });
  }
  return events;
}

function signatureOptions(
  cursor: EscrowFinalizedCursor,
  before: string | undefined,
): SignaturesForAddressOptions {
  const common = { limit: 1_000, ...(before === undefined ? {} : { before }) };
  return cursor.signature === null ? common : { ...common, until: cursor.signature };
}

async function signaturesSince(
  connection: Connection,
  program: PublicKey,
  cursor: EscrowFinalizedCursor,
  maximumBacklog: number,
): Promise<readonly ConfirmedSignatureInfo[]> {
  const signatures: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  while (true) {
    const page = await connection.getSignaturesForAddress(
      program,
      signatureOptions(cursor, before),
      'finalized',
    );
    for (const item of page) {
      if (cursor.signature === null && BigInt(item.slot) <= cursor.slot) continue;
      signatures.push(item);
      if (signatures.length > maximumBacklog) {
        throw new EscrowFinalizedSourceError('backlog_limit_exceeded');
      }
    }
    const last = page.at(-1);
    if (
      page.length < 1_000 || last === undefined ||
      (cursor.signature === null && BigInt(last.slot) <= cursor.slot)
    ) break;
    before = last.signature;
  }
  return signatures.reverse();
}

export class SolanaFinalizedEscrowEventSource implements EscrowFinalizedEventSource {
  constructor(
    private readonly connection: Connection,
    private readonly expected: { readonly genesisHash: string; readonly programId: string },
    private readonly projector: EscrowEventProjector,
    private readonly maximumBacklog = 10_000,
  ) {}

  async scan(cursor: EscrowFinalizedCursor, limit: number): Promise<readonly EscrowFinalizedTransaction[]> {
    if (await this.connection.getGenesisHash() !== this.expected.genesisHash) {
      throw new EscrowFinalizedSourceError('network_mismatch');
    }
    const signatures = await signaturesSince(
      this.connection,
      new PublicKey(this.expected.programId),
      cursor,
      this.maximumBacklog,
    );
    const transactions: EscrowFinalizedTransaction[] = [];
    for (const signature of signatures.slice(0, limit)) {
      const transaction = await this.connection.getTransaction(signature.signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      if (transaction === null) throw new EscrowFinalizedSourceError('transaction_unavailable');
      const events: EscrowFinalizedEvent[] = [];
      const logs = transaction.meta?.err === null ? transaction.meta.logMessages ?? [] : [];
      for (const located of eventLogs(logs, this.expected.programId)) {
        events.push({
          instructionIndex: located.instructionIndex,
          projection: {
            resolve: () => this.projector.project(located.event, {
              signature: signature.signature,
              instructionIndex: located.instructionIndex,
              slot: BigInt(signature.slot),
            }),
          },
        });
      }
      const blockTime = transaction.blockTime ?? signature.blockTime;
      transactions.push({
        signature: signature.signature,
        slot: BigInt(signature.slot),
        blockTimeIso: blockTime === null || blockTime === undefined
          ? null
          : new Date(blockTime * 1_000).toISOString(),
        genesisHash: this.expected.genesisHash,
        programId: this.expected.programId,
        events,
      });
    }
    return transactions;
  }
}
