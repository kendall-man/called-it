import type {
  EngineReadinessPorts,
  FeedReadinessPort,
  QueueReadinessPort,
} from './readiness-checks.js';

type BetaReadinessBase = Omit<EngineReadinessPorts, 'telegram'>;

export interface BetaReadinessOptions {
  readonly base: BetaReadinessBase;
  readonly feed: FeedReadinessPort;
  readonly settlement: QueueReadinessPort;
}

export function createBetaReadinessPorts(
  options: BetaReadinessOptions,
): BetaReadinessBase {
  return {
    ...options.base,
    feed: options.feed,
    proof: {
      async snapshot(signal) {
        signal.throwIfAborted();
        return {
          enabled: false,
          heartbeatAtMs: null,
          backlog: 0,
          oldestAgeMs: null,
        };
      },
    },
    settlement: options.settlement,
  };
}
