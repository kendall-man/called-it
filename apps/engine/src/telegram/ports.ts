declare const telegramSourceKeyBrand: unique symbol;
declare const telegramSourceFingerprintBrand: unique symbol;

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

export type TelegramSourceKey = string & {
  readonly [telegramSourceKeyBrand]: 'TelegramSourceKey';
};

export type TelegramSourceFingerprint = string & {
  readonly [telegramSourceFingerprintBrand]: 'TelegramSourceFingerprint';
};

export type TelegramValidatedUpdate = Readonly<Record<string, unknown>>;

export type TelegramOwnershipResolution = 'engine' | 'unknown';

export type TelegramOwnedMessageResolver = (
  chatId: number,
  messageId: number,
) => Promise<TelegramOwnershipResolution>;

export type TelegramPrefilter = (text: string) => Promise<boolean>;

export interface TelegramPersistResult {
  readonly id: string;
  readonly routingDecision: TelegramRoutingDecision;
  readonly state: TelegramUpdateState;
  readonly duplicate: boolean;
}

export interface TelegramPersistPort {
  persistUpdate(input: {
    readonly sourceKey: TelegramSourceKey;
    readonly sourceFingerprint: TelegramSourceFingerprint;
    readonly telegramUpdateId: number;
    readonly updateType: string;
    readonly payload: TelegramValidatedUpdate;
    readonly routingDecision: TelegramRoutingDecision;
  }): Promise<TelegramPersistResult>;
}
