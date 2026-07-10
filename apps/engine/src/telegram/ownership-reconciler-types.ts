export interface TelegramOwnershipReconciliationJob {
  readonly id: string;
  readonly chatId: number;
  readonly domainKind: string;
  readonly domainId: string;
  readonly reconcileAttempts: number;
}

export type TelegramOwnershipMutationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string };

export interface TelegramOwnershipReconcilerPort {
  heartbeatWorker(
    workerKind: 'telegram_ownership_reconciler',
    workerId: string,
    stopping: boolean,
  ): Promise<void>;
  leaseUncertainOwnership(
    workerId: string,
    limit: number,
    leaseMs: number,
  ): Promise<readonly TelegramOwnershipReconciliationJob[]>;
  reconcileOutbound(
    jobId: string,
    workerId: string,
    messageId: number,
  ): Promise<TelegramOwnershipMutationResult>;
  manualReviewOutbound(
    jobId: string,
    workerId: string,
    errorCode: string,
  ): Promise<TelegramOwnershipMutationResult>;
}

export type TelegramOwnershipResolver = (
  domainId: string,
  expectedChatId: number,
) => Promise<number | null>;

export type TelegramOwnershipResolverRegistry = Readonly<Record<string, TelegramOwnershipResolver>>;

export interface MarketCardEvidencePort {
  getMarket(marketId: string): Promise<{
    readonly group_id: number;
    readonly card_tg_message_id: number | null;
  } | null>;
}

export interface TelegramOwnershipReconcilerOptions {
  readonly db: TelegramOwnershipReconcilerPort;
  readonly resolvers: TelegramOwnershipResolverRegistry;
  readonly workerId: string;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
}

export class TelegramOwnershipReconcilerConfigurationError extends Error {
  readonly name = 'TelegramOwnershipReconcilerConfigurationError';

  constructor() {
    super('invalid Telegram ownership reconciler configuration');
  }
}
