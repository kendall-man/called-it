import { TelegramOwnershipReconcilerConfigurationError } from './ownership-reconciler-types.js';
import type {
  MarketCardEvidencePort,
  TelegramOwnershipReconcilerOptions,
  TelegramOwnershipResolver,
} from './ownership-reconciler-types.js';

export type ReconciliationFailureCode =
  | 'authoritative_id_missing'
  | 'invalid_authoritative_id'
  | 'reconcile_failed'
  | 'reconcile_rejected'
  | 'resolver_failed'
  | 'unknown_domain_kind';

export type ResolverOutcome =
  | { readonly kind: 'found'; readonly messageId: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'resolver_failed' };

export type ReconcileOutcome =
  | { readonly kind: 'reconciled' }
  | { readonly kind: 'reconcile_failed' }
  | { readonly kind: 'reconcile_rejected' };

export function createMarketCardOwnershipResolver(
  markets: MarketCardEvidencePort,
): TelegramOwnershipResolver {
  return async (marketId, expectedChatId) => {
    const market = await markets.getMarket(marketId);
    if (market === null || market.group_id !== expectedChatId) return null;
    return market.card_tg_message_id;
  };
}

export function toResolverOutcome(messageId: number | null): ResolverOutcome {
  if (messageId === null) return { kind: 'missing' };
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return { kind: 'invalid' };
  return { kind: 'found', messageId };
}

export function validateOptions(options: TelegramOwnershipReconcilerOptions): void {
  if (options.workerId.length === 0) {
    throw new TelegramOwnershipReconcilerConfigurationError();
  }
  assertBoundedInteger(options.batchSize, 1, 100);
  assertBoundedInteger(options.leaseMs, 1, 86_400_000);
  assertBoundedInteger(options.maxAttempts, 1, 100);
}

export function waitForCycles(cycles: readonly Promise<number>[], signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.allSettled(cycles).then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

export function assertNever(value: never): never {
  void value;
  throw new TelegramOwnershipReconcilerConfigurationError();
}

function assertBoundedInteger(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TelegramOwnershipReconcilerConfigurationError();
  }
}
