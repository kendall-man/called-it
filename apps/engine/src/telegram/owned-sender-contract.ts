export const DEFAULT_RETRY_DELAY_MS = 25;

export type OwnedTelegramOutboundState =
  | 'planned'
  | 'sending'
  | 'owned'
  | 'complete'
  | 'ownership_uncertain'
  | 'reconciled'
  | 'manual_review';

export type DurableUncertaintyState = Extract<
  OwnedTelegramOutboundState,
  'ownership_uncertain' | 'reconciled' | 'manual_review'
>;

export type OwnedTelegramCompletionState = Extract<OwnedTelegramOutboundState, 'owned' | 'reconciled'>;

export interface OwnedTelegramOutboundIdentity {
  readonly chatId: number;
  readonly domainKind: string;
  readonly domainId: string;
}

export interface OwnedTelegramPlanInput extends OwnedTelegramOutboundIdentity {
  readonly logicalKey: string;
}

export type OwnedTelegramPlanResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly state: OwnedTelegramOutboundState;
      readonly chatId: number;
      readonly domainKind: string;
      readonly domainId: string;
      readonly messageId: number | null;
      readonly duplicate: boolean;
    }
  | { readonly ok: false; readonly code: string };

export type OwnedTelegramStartResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly state: 'sending';
      readonly chatId: number;
      readonly domainKind: string;
      readonly domainId: string;
      readonly leaseExpiresAt: string;
    }
  | { readonly ok: false; readonly code: string; readonly state?: OwnedTelegramOutboundState };

export type OwnedTelegramActionResult =
  | { readonly ok: true; readonly state: OwnedTelegramOutboundState; readonly duplicate: boolean }
  | { readonly ok: false; readonly code: string; readonly state?: OwnedTelegramOutboundState };

export interface OwnedTelegramSenderDb {
  planOutbound(input: OwnedTelegramPlanInput): Promise<OwnedTelegramPlanResult>;
  startOutbound(jobId: string, workerId: string, leaseMs: number): Promise<OwnedTelegramStartResult>;
  markOutboundOwned(jobId: string, workerId: string, messageId: number): Promise<OwnedTelegramActionResult>;
  markOutboundUncertain(jobId: string, workerId: string, errorCode: string): Promise<OwnedTelegramActionResult>;
}

export interface OwnedTelegramSendInput extends OwnedTelegramPlanInput {
  readonly send: (signal: AbortSignal) => Promise<number>;
  readonly recordAuthoritativeMessageId?: (messageId: number) => Promise<void>;
}

export interface OwnedTelegramSenderOptions {
  readonly db: OwnedTelegramSenderDb;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly now?: () => number;
  readonly retryDelayMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export type OwnedTelegramSendResult =
  | { readonly kind: 'complete'; readonly jobId: string; readonly messageId: number }
  | {
      readonly kind: 'owned';
      readonly jobId: string;
      readonly messageId: number;
      readonly state: OwnedTelegramCompletionState;
    }
  | {
      readonly kind: 'uncertain';
      readonly jobId: string;
      readonly messageId: number | null;
      readonly state: DurableUncertaintyState;
    }
  | {
      readonly kind: 'skipped';
      readonly jobId: string | null;
      readonly state: OwnedTelegramOutboundState | null;
      readonly code: string;
    };

export type OwnedTelegramDrainResult =
  | { readonly kind: 'drained' }
  | { readonly kind: 'timeout'; readonly unfinished: number };

export function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isTelegramMessageId(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function durableUncertaintyResult(
  jobId: string,
  messageId: number | null,
  state: DurableUncertaintyState,
): OwnedTelegramSendResult {
  return { kind: 'uncertain', jobId, messageId, state };
}

export function outcomeFromDurableState(
  jobId: string,
  messageId: number | null,
  state: OwnedTelegramOutboundState | undefined,
): OwnedTelegramSendResult | null {
  switch (state) {
    case 'complete':
      return messageId === null ? null : { kind: 'complete', jobId, messageId };
    case 'ownership_uncertain':
    case 'reconciled':
    case 'manual_review':
      return durableUncertaintyResult(jobId, messageId, state);
    default:
      return null;
  }
}
