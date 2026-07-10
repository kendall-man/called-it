import type { OwnedTelegramActionResult, OwnedTelegramOutboundState } from './owned-sender-contract.js';

export type TelegramOutboundCompletionState = Extract<
  OwnedTelegramOutboundState,
  'owned' | 'reconciled'
>;

export interface TelegramOutboundCompletionLease {
  readonly id: string;
  readonly state: TelegramOutboundCompletionState;
  readonly chatId: number;
  readonly domainKind: string;
  readonly domainId: string;
  readonly telegramMessageId: number;
  readonly leaseExpiresAt: string;
}

export interface TelegramOutboundCompletionDb {
  leaseOutboundCompletion(
    workerId: string,
    limit: number,
    leaseMs: number,
  ): Promise<readonly TelegramOutboundCompletionLease[]>;
  completeOutbound(jobId: string, workerId: string): Promise<OwnedTelegramActionResult>;
}

export type TelegramOutboundCompletionHandler = (
  job: TelegramOutboundCompletionLease,
  signal: AbortSignal,
) => Promise<void>;

export type TelegramOutboundCompletionRegistry = Readonly<
  Record<string, TelegramOutboundCompletionHandler>
>;

export interface TelegramOutboundCompletionWorkerOptions {
  readonly db: TelegramOutboundCompletionDb;
  readonly handlers: TelegramOutboundCompletionRegistry;
  readonly workerId: string;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly now?: () => number;
  readonly retryDelayMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export type TelegramOutboundCompletionResult =
  | { readonly kind: 'complete'; readonly jobId: string }
  | { readonly kind: 'lease_expired'; readonly jobId: string }
  | { readonly kind: 'aborted'; readonly jobId: string }
  | { readonly kind: 'skipped'; readonly jobId: string | null; readonly code: string };

export type TelegramOutboundCompletionDrainResult =
  | { readonly kind: 'drained' }
  | { readonly kind: 'timeout'; readonly unfinished: number };

export class TelegramOutboundCompletionWorkerConfigError extends Error {
  readonly name = 'TelegramOutboundCompletionWorkerConfigError';

  constructor() {
    super('invalid Telegram outbound completion worker configuration');
  }
}
