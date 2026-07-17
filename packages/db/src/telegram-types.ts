export const TELEGRAM_ROUTING_DECISIONS = ['pending_engine', 'routed_concierge'] as const;
export type TelegramRoutingDecision = (typeof TELEGRAM_ROUTING_DECISIONS)[number];

export const TELEGRAM_UPDATE_STATES = [
  'pending_engine',
  'routed_concierge',
  'leased',
  'retry_wait',
  'completed',
  'dead',
] as const;
export type TelegramUpdateState = (typeof TELEGRAM_UPDATE_STATES)[number];

export const TELEGRAM_OUTBOUND_STATES = [
  'planned',
  'sending',
  'owned',
  'complete',
  'ownership_uncertain',
  'reconciled',
  'manual_review',
] as const;
export type TelegramOutboundState = (typeof TELEGRAM_OUTBOUND_STATES)[number];

export const TELEGRAM_WORKER_KINDS = [
  'telegram_ingress',
  'telegram_outbound',
  'telegram_ownership_reconciler',
] as const;
export type TelegramWorkerKind = (typeof TELEGRAM_WORKER_KINDS)[number];

export const TELEGRAM_DB_CODES = [
  'invalid_input',
  'source_conflict',
  'logical_key_conflict',
  'not_due',
  'lease_lost',
  'terminal_state',
  'ownership_conflict',
  'not_found',
] as const;
export type TelegramDbCode = (typeof TELEGRAM_DB_CODES)[number];

export type TelegramActionResult<S extends string> =
  | { readonly ok: true; readonly id: string; readonly state: S; readonly duplicate: boolean }
  | { readonly ok: false; readonly code: TelegramDbCode; readonly state?: S };

export interface TelegramLeaseUpdateItem {
  readonly id: string;
  readonly telegramUpdateId: number;
  readonly updateType: string;
  readonly routingDecision: TelegramRoutingDecision;
  readonly state: Extract<TelegramUpdateState, 'leased'>;
  readonly attempts: number;
  readonly sourceFingerprint: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly leaseExpiresAt: string;
}

export interface TelegramPersistResult {
  readonly ok: true;
  readonly id: string;
  readonly routingDecision: TelegramRoutingDecision;
  readonly state: TelegramUpdateState;
  readonly duplicate: boolean;
}

export interface TelegramPlanOutboundResult {
  readonly ok: true;
  readonly id: string;
  readonly state: Extract<TelegramOutboundState, 'planned' | 'sending' | 'owned' | 'complete' | 'ownership_uncertain' | 'reconciled' | 'manual_review'>;
  readonly chatId: number;
  readonly domainKind: string;
  readonly domainId: string;
  readonly duplicate: boolean;
}

export interface TelegramStartOutboundResult {
  readonly ok: true;
  readonly id: string;
  readonly state: Extract<TelegramOutboundState, 'sending'>;
  readonly chatId: number;
  readonly domainKind: string;
  readonly domainId: string;
  readonly leaseExpiresAt: string;
}

export interface TelegramLeaseOwnershipItem {
  readonly id: string;
  readonly chatId: number;
  readonly domainKind: string;
  readonly domainId: string;
  readonly state: Extract<TelegramOutboundState, 'ownership_uncertain'>;
  readonly reconcileAttempts: number;
  readonly leaseExpiresAt: string;
}

export interface TelegramLeaseCompletionItem {
  readonly id: string;
  readonly chatId: number;
  readonly domainKind: string;
  readonly domainId: string;
  readonly state: Extract<TelegramOutboundState, 'owned' | 'reconciled'>;
  readonly telegramMessageId: number;
  readonly leaseExpiresAt: string;
}

export type TelegramResolveOwnedMessageResult =
  | { readonly ok: true; readonly owner: 'unknown' }
  | {
      readonly ok: true;
      readonly owner: 'engine';
      readonly jobId: string;
      readonly domainKind: string;
      readonly domainId: string;
    }
  | { readonly ok: false; readonly code: TelegramDbCode };

export interface TelegramDeliverySnapshot {
  readonly ok: true;
  readonly observedAt: string;
  readonly ingressActiveCount: number;
  readonly ingressDeadCount: number;
  readonly ingressOldestAgeMs: number | null;
  readonly outboundUncertainCount: number;
  readonly outboundManualReviewCount: number;
  readonly outboundOldestAgeMs: number | null;
  readonly workers: readonly TelegramWorkerHeartbeatSnapshot[];
}

export interface TelegramWorkerHeartbeatSnapshot {
  readonly workerKind: TelegramWorkerKind;
  readonly workerId: string;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly stoppingAt: string | null;
}

export interface TelegramPruneDeliveryResult {
  readonly ok: true;
  readonly purgedPayloads: number;
  readonly deletedIngressRows: number;
  readonly deletedOutboundJobs: number;
  readonly deletedHeartbeats: number;
}
