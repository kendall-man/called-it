import type {
  Comparator,
  SettlementOutcome,
  TrustTier,
} from '@calledit/market-engine';

export interface RecoveryLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface RecoveredSettlementFact {
  readonly marketId: string;
  readonly fixtureId: number;
  readonly outcome: SettlementOutcome;
  readonly tier: TrustTier;
  readonly decidingSeq: number | null;
  readonly comparator: Comparator;
  readonly threshold: number;
  readonly statKey: number | null;
}

export interface SettlementFactSource {
  find(marketId: string): Promise<RecoveredSettlementFact | null>;
}

export interface SettlementEffects {
  apply(marketId: string): Promise<void>;
}

export interface SettlementReceiptDelivery {
  /** Resolves delivered only after the chat's durable post marker may be written. */
  deliver(fact: RecoveredSettlementFact): Promise<'delivered' | 'pending'>;
}
