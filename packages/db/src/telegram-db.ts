import { createClient } from '@supabase/supabase-js';
import { requireTelegramDbClient, type TelegramDbClient } from './telegram-db-core.js';
import { telegramRpcMethods } from './telegram-db-rpc.js';
import type {
  TelegramActionResult,
  TelegramDeliverySnapshot,
  TelegramLeaseCompletionItem,
  TelegramLeaseOwnershipItem,
  TelegramLeaseUpdateItem,
  TelegramOutboundState,
  TelegramPersistResult,
  TelegramPlanOutboundResult,
  TelegramPruneDeliveryResult,
  TelegramResolveOwnedMessageResult,
  TelegramRoutingDecision,
  TelegramStartOutboundResult,
  TelegramUpdateState,
  TelegramWorkerKind,
} from './telegram-types.js';

export type { TelegramDbClient } from './telegram-db-core.js';

export interface TelegramDb {
  persistUpdate(input: {
    readonly sourceKey: string;
    readonly sourceFingerprint: string;
    readonly telegramUpdateId: number;
    readonly updateType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly routingDecision: TelegramRoutingDecision;
  }): Promise<TelegramPersistResult | { readonly ok: false; readonly code: import('./telegram-types.js').TelegramDbCode }>;
  leaseUpdates(workerId: string, limit: number, leaseMs: number): Promise<readonly TelegramLeaseUpdateItem[]>;
  completeUpdate(updateRowId: string, workerId: string): Promise<TelegramActionResult<TelegramUpdateState>>;
  retryUpdate(input: {
    readonly updateRowId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly retryAt: string;
    readonly maxAttempts: number;
  }): Promise<TelegramActionResult<TelegramUpdateState>>;
  deadLetterUpdate(updateRowId: string, workerId: string, errorCode: string): Promise<TelegramActionResult<TelegramUpdateState>>;
  planOutbound(input: {
    readonly logicalKey: string;
    readonly chatId: number;
    readonly domainKind: string;
    readonly domainId: string;
  }): Promise<TelegramPlanOutboundResult | { readonly ok: false; readonly code: import('./telegram-types.js').TelegramDbCode }>;
  startOutbound(jobId: string, workerId: string, leaseMs: number): Promise<TelegramStartOutboundResult | { readonly ok: false; readonly code: import('./telegram-types.js').TelegramDbCode }>;
  markOutboundOwned(jobId: string, workerId: string, messageId: number): Promise<TelegramActionResult<TelegramOutboundState>>;
  completeOutbound(jobId: string, workerId: string): Promise<TelegramActionResult<TelegramOutboundState>>;
  markOutboundUncertain(jobId: string, workerId: string, errorCode: string): Promise<TelegramActionResult<TelegramOutboundState>>;
  sweepExpiredOutbound(limit: number): Promise<number>;
  leaseUncertainOwnership(workerId: string, limit: number, leaseMs: number): Promise<readonly TelegramLeaseOwnershipItem[]>;
  leaseOutboundCompletion(workerId: string, limit: number, leaseMs: number): Promise<readonly TelegramLeaseCompletionItem[]>;
  reconcileOutbound(jobId: string, workerId: string, messageId: number): Promise<TelegramActionResult<TelegramOutboundState>>;
  manualReviewOutbound(jobId: string, workerId: string, errorCode: string): Promise<TelegramActionResult<TelegramOutboundState>>;
  resolveOwnedMessage(chatId: number, messageId: number): Promise<TelegramResolveOwnedMessageResult>;
  heartbeatWorker(workerKind: TelegramWorkerKind, workerId: string, stopping: boolean): Promise<void>;
  deliverySnapshot(observedAt: string): Promise<TelegramDeliverySnapshot>;
  pruneDelivery(limit: number): Promise<TelegramPruneDeliveryResult>;
}

export function createTelegramDb(url: string, serviceRoleKey: string): TelegramDb {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return telegramDbFromClient(client);
}

export function telegramDbFromClient(candidate: unknown): TelegramDb {
  const client: TelegramDbClient = requireTelegramDbClient(candidate);
  return {
    ...telegramRpcMethods(client),
  } satisfies TelegramDb;
}
