import type {
  RecordTerminalSettlementResult,
  SettlementProofJobsDb,
  SettlementProofOutcome,
  SettlementProofTier,
} from '@calledit/db';

export interface RecoveryClock {
  now(): number;
}

export interface DurableQueuePolicy {
  readonly maxAttempts: number;
  readonly leaseMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly initialChainProofDelayMs: number;
}

export interface TerminalSettlementFact {
  readonly marketId: string;
  readonly outcome: SettlementProofOutcome;
  readonly decidingSeq: number | null;
  readonly evidenceSeqs: readonly number[];
  readonly tier: SettlementProofTier;
}

export interface SettlementJournal {
  recordTerminal(fact: TerminalSettlementFact): Promise<RecordTerminalSettlementResult>;
  markPosted(marketId: string): Promise<void>;
}

export class DurableSettlementError extends Error {
  readonly name = 'DurableSettlementError';

  constructor(
    readonly operation: 'record_terminal' | 'mark_posted',
    readonly code: string,
  ) {
    super(`durable settlement ${operation} rejected: ${code}`);
  }
}

export function createSettlementJournal(options: {
  readonly jobs: SettlementProofJobsDb;
  readonly clock: RecoveryClock;
  readonly policy: DurableQueuePolicy;
}): SettlementJournal {
  return {
    async recordTerminal(fact) {
      const result = await options.jobs.recordTerminalSettlement({
        marketId: fact.marketId,
        outcome: fact.outcome,
        decidingSeq: fact.decidingSeq,
        evidenceSeqs: fact.evidenceSeqs,
        tier: fact.tier,
        nowIso: nowIso(options.clock),
        maxAttempts: options.policy.maxAttempts,
        leaseMs: options.policy.leaseMs,
        retryBaseMs: options.policy.retryBaseMs,
        retryMaxMs: options.policy.retryMaxMs,
      });
      if (!result.ok) {
        throw new DurableSettlementError('record_terminal', result.code);
      }
      return result;
    },

    async markPosted(marketId) {
      const result = await options.jobs.markSettlementPosted(marketId, nowIso(options.clock));
      if (!result.ok) {
        throw new DurableSettlementError('mark_posted', result.code);
      }
    },
  };
}

export function nowIso(clock: RecoveryClock): string {
  return isoAt(clock.now());
}

export function isoAt(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs)) {
    throw new DurableSettlementError('record_terminal', 'invalid_clock');
  }
  return new Date(nowMs).toISOString();
}
