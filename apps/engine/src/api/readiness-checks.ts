import { ENGINE_READINESS_REASONS, type ReadinessCheckPort } from './readiness.js';

export interface DatabaseReadinessPort {
  probe(signal: AbortSignal): Promise<void>;
}

export interface FeedReadinessSnapshot {
  readonly activePricingExpected: boolean;
  readonly lastEventAtMs: number | null;
}

export interface FeedReadinessPort {
  snapshot(signal: AbortSignal): Promise<FeedReadinessSnapshot>;
}

export interface WagerReadinessSnapshot {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly runtimeMatches: boolean;
  readonly paused: boolean;
  readonly covered: boolean;
  readonly starterIntakeReady: boolean;
}

export interface WagerReadinessPort {
  snapshot(signal: AbortSignal): Promise<WagerReadinessSnapshot>;
}

export interface WorkerReadinessSnapshot {
  readonly heartbeatAtMs: number | null;
}

export interface WorkerReadinessPort {
  snapshot(signal: AbortSignal): Promise<WorkerReadinessSnapshot>;
}

export interface QueueReadinessSnapshot extends WorkerReadinessSnapshot {
  readonly enabled: boolean;
  readonly backlog: number;
  readonly oldestAgeMs: number | null;
}

export interface QueueReadinessPort {
  snapshot(signal: AbortSignal): Promise<QueueReadinessSnapshot>;
}

export interface EngineReadinessPorts {
  readonly database: DatabaseReadinessPort;
  readonly feed: FeedReadinessPort;
  readonly wager: WagerReadinessPort;
  readonly telegram: WorkerReadinessPort;
  readonly proof: QueueReadinessPort;
  readonly settlement: QueueReadinessPort;
}

export interface EngineReadinessPolicy {
  readonly checkTimeoutMs: number;
  readonly feedMaxAgeMs: number;
  readonly ingressMaxAgeMs: number;
  readonly workerMaxAgeMs: number;
  readonly proofMaxBacklog: number;
  readonly proofMaxOldestAgeMs: number;
  readonly settlementMaxBacklog: number;
  readonly settlementMaxOldestAgeMs: number;
}

export const DEFAULT_ENGINE_READINESS_POLICY: EngineReadinessPolicy = {
  checkTimeoutMs: 1_000,
  feedMaxAgeMs: 20 * 60_000,
  ingressMaxAgeMs: 2 * 60_000,
  workerMaxAgeMs: 2 * 60_000,
  proofMaxBacklog: 100,
  proofMaxOldestAgeMs: 10 * 60_000,
  settlementMaxBacklog: 100,
  settlementMaxOldestAgeMs: 10 * 60_000,
};

export function createEngineReadinessChecks(
  ports: EngineReadinessPorts,
  _policy: EngineReadinessPolicy,
  _now: () => number,
): readonly ReadinessCheckPort[] {
  const database = {
    name: 'database',
    unavailableReason: ENGINE_READINESS_REASONS.databaseUnavailable,
    timeoutReason: ENGINE_READINESS_REASONS.databaseTimeout,
    async check(signal: AbortSignal) {
      await ports.database.probe(signal);
      return { kind: 'ready' };
    },
  } satisfies ReadinessCheckPort;
  const feed = {
    name: 'feed',
    unavailableReason: ENGINE_READINESS_REASONS.feedUnavailable,
    timeoutReason: ENGINE_READINESS_REASONS.feedTimeout,
    async check(signal: AbortSignal) {
      const snapshot = await ports.feed.snapshot(signal);
      if (!snapshot.activePricingExpected) {
        return { kind: 'disabled', reason: ENGINE_READINESS_REASONS.feedInactive };
      }
      if (snapshot.lastEventAtMs === null) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.feedUnavailable };
      }
      if (_now() - snapshot.lastEventAtMs > _policy.feedMaxAgeMs) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.feedStale };
      }
      return { kind: 'ready' };
    },
  } satisfies ReadinessCheckPort;
  const wager = {
    name: 'wager',
    unavailableReason: ENGINE_READINESS_REASONS.wagerUnavailable,
    timeoutReason: ENGINE_READINESS_REASONS.wagerTimeout,
    async check(signal: AbortSignal) {
      const snapshot = await ports.wager.snapshot(signal);
      if (!snapshot.runtimeMatches) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.wagerUnavailable };
      }
      if (!snapshot.enabled) {
        return { kind: 'disabled', reason: ENGINE_READINESS_REASONS.wagerDisabled };
      }
      if (!snapshot.configured) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.wagerUnavailable };
      }
      if (!snapshot.starterIntakeReady) {
        return {
          kind: 'not_ready',
          reason: ENGINE_READINESS_REASONS.starterIntakeUnavailable,
        };
      }
      if (!snapshot.covered) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.solvencyUncovered };
      }
      if (snapshot.paused) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.wagerPaused };
      }
      return { kind: 'ready' };
    },
  } satisfies ReadinessCheckPort;
  const telegram = {
    name: 'telegram',
    unavailableReason: ENGINE_READINESS_REASONS.telegramWorkerUnavailable,
    timeoutReason: ENGINE_READINESS_REASONS.telegramWorkerTimeout,
    async check(signal: AbortSignal) {
      const snapshot = await ports.telegram.snapshot(signal);
      if (snapshot.heartbeatAtMs === null) {
        return {
          kind: 'not_ready',
          reason: ENGINE_READINESS_REASONS.telegramWorkerUnavailable,
        };
      }
      if (_now() - snapshot.heartbeatAtMs > _policy.ingressMaxAgeMs) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.telegramWorkerStale };
      }
      return { kind: 'ready' };
    },
  } satisfies ReadinessCheckPort;
  const proof = {
    name: 'proof',
    unavailableReason: ENGINE_READINESS_REASONS.proofWorkerUnavailable,
    timeoutReason: ENGINE_READINESS_REASONS.proofWorkerTimeout,
    async check(signal: AbortSignal) {
      const snapshot = await ports.proof.snapshot(signal);
      if (!snapshot.enabled) {
        return {
          kind: 'disabled',
          reason: ENGINE_READINESS_REASONS.proofSubmissionDisabled,
        };
      }
      if (snapshot.heartbeatAtMs === null) {
        return {
          kind: 'not_ready',
          reason: ENGINE_READINESS_REASONS.proofWorkerUnavailable,
        };
      }
      if (_now() - snapshot.heartbeatAtMs > _policy.workerMaxAgeMs) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.proofWorkerStale };
      }
      if (snapshot.backlog > _policy.proofMaxBacklog) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.proofBacklog };
      }
      if (
        snapshot.oldestAgeMs !== null &&
        snapshot.oldestAgeMs > _policy.proofMaxOldestAgeMs
      ) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.proofOldestStale };
      }
      return { kind: 'ready' };
    },
  } satisfies ReadinessCheckPort;
  const settlement = {
    name: 'settlement',
    unavailableReason: ENGINE_READINESS_REASONS.settlementWorkerUnavailable,
    timeoutReason: ENGINE_READINESS_REASONS.settlementWorkerTimeout,
    async check(signal: AbortSignal) {
      const snapshot = await ports.settlement.snapshot(signal);
      if (!snapshot.enabled) {
        return {
          kind: 'disabled',
          reason: ENGINE_READINESS_REASONS.settlementReconciliationDisabled,
        };
      }
      if (snapshot.heartbeatAtMs === null) {
        return {
          kind: 'not_ready',
          reason: ENGINE_READINESS_REASONS.settlementWorkerUnavailable,
        };
      }
      if (_now() - snapshot.heartbeatAtMs > _policy.workerMaxAgeMs) {
        return {
          kind: 'not_ready',
          reason: ENGINE_READINESS_REASONS.settlementWorkerStale,
        };
      }
      if (snapshot.backlog > _policy.settlementMaxBacklog) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.settlementBacklog };
      }
      if (
        snapshot.oldestAgeMs !== null &&
        snapshot.oldestAgeMs > _policy.settlementMaxOldestAgeMs
      ) {
        return { kind: 'not_ready', reason: ENGINE_READINESS_REASONS.settlementOldestStale };
      }
      return { kind: 'ready' };
    },
  } satisfies ReadinessCheckPort;
  return [database, feed, wager, telegram, proof, settlement];
}
