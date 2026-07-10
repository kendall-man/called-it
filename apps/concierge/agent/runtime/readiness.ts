function defineReasonCodes<const Codes extends Readonly<Record<string, string>>>(
  codes: Codes,
): Codes {
  return codes;
}

export const CONCIERGE_READINESS_REASONS = defineReasonCodes({
  runtimeConfigurationInvalid: 'runtime_configuration_invalid',
  runtimeTimeout: 'runtime_timeout',
  engineUnavailable: 'engine_unavailable',
  engineTimeout: 'engine_timeout',
  engineNotReady: 'engine_not_ready',
  engineContractInvalid: 'engine_contract_invalid',
  draining: 'draining',
});

export type ConciergeReadinessReason =
  (typeof CONCIERGE_READINESS_REASONS)[keyof typeof CONCIERGE_READINESS_REASONS];

export interface ConciergeReadinessReport {
  readonly status: 'ready' | 'not_ready';
  readonly reasons: readonly ConciergeReadinessReason[];
}

export interface ConciergeReadinessEvaluator {
  evaluate(): Promise<ConciergeReadinessReport>;
}

export interface RuntimeReadinessPort {
  probe(signal: AbortSignal): Promise<void>;
}

export interface EngineReadinessPort {
  probe(signal: AbortSignal): Promise<'ready' | 'not_ready' | 'invalid'>;
}

export interface ReadinessDeadlinePort {
  wait(timeoutMs: number, signal: AbortSignal): Promise<void>;
}

export const SYSTEM_READINESS_DEADLINE: ReadinessDeadlinePort = {
  wait(timeoutMs, signal) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return;
      const timer = setTimeout(resolve, timeoutMs);
      signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    });
  },
};

export interface ConciergeDrainPort {
  isDraining(): boolean;
}

export interface ConciergeReadinessOptions {
  readonly runtime: RuntimeReadinessPort;
  readonly engine: EngineReadinessPort;
  readonly runtimeTimeoutMs: number;
  readonly engineTimeoutMs: number;
  readonly deadline: ReadinessDeadlinePort;
  readonly drain: ConciergeDrainPort;
}

function drainingReport(): ConciergeReadinessReport {
  return {
    status: 'not_ready',
    reasons: [CONCIERGE_READINESS_REASONS.draining],
  };
}

type BoundedOutcome<T> =
  | { readonly kind: 'result'; readonly value: T }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'timeout' };

async function runBounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  deadline: ReadinessDeadlinePort,
): Promise<BoundedOutcome<T>> {
  const controller = new AbortController();
  const completed = operation(controller.signal).then<BoundedOutcome<T>, BoundedOutcome<T>>(
    (value) => ({ kind: 'result', value }),
    () => ({ kind: 'unavailable' }),
  );
  const expired = deadline
    .wait(timeoutMs, controller.signal)
    .then<BoundedOutcome<T>>(() => ({ kind: 'timeout' }));
  const outcome = await Promise.race([completed, expired]);
  controller.abort();
  return outcome;
}

export function createConciergeReadiness(
  options: ConciergeReadinessOptions,
): ConciergeReadinessEvaluator {
  return {
    async evaluate() {
      if (options.drain.isDraining()) {
        return drainingReport();
      }
      const runtime = await runBounded(
        (signal) => options.runtime.probe(signal),
        options.runtimeTimeoutMs,
        options.deadline,
      );
      if (options.drain.isDraining()) {
        return drainingReport();
      }
      if (runtime.kind === 'timeout') {
        return {
          status: 'not_ready',
          reasons: [CONCIERGE_READINESS_REASONS.runtimeTimeout],
        };
      }
      if (runtime.kind === 'unavailable') {
        return {
          status: 'not_ready',
          reasons: [CONCIERGE_READINESS_REASONS.runtimeConfigurationInvalid],
        };
      }
      const engine = await runBounded(
        (signal) => options.engine.probe(signal),
        options.engineTimeoutMs,
        options.deadline,
      );
      if (options.drain.isDraining()) {
        return drainingReport();
      }
      if (engine.kind === 'timeout') {
        return {
          status: 'not_ready',
          reasons: [CONCIERGE_READINESS_REASONS.engineTimeout],
        };
      }
      if (engine.kind === 'unavailable') {
        return {
          status: 'not_ready',
          reasons: [CONCIERGE_READINESS_REASONS.engineUnavailable],
        };
      }
      if (engine.value === 'invalid') {
        return {
          status: 'not_ready',
          reasons: [CONCIERGE_READINESS_REASONS.engineContractInvalid],
        };
      }
      if (engine.kind === 'result' && engine.value === 'not_ready') {
        return {
          status: 'not_ready',
          reasons: [CONCIERGE_READINESS_REASONS.engineNotReady],
        };
      }
      return { status: 'ready', reasons: [] };
    },
  };
}
