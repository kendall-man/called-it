import type { Logger } from '../log.js';
import type { EscrowReadinessReport } from './readiness.js';

export interface EscrowReadinessHealthCheck {
  check(signal: AbortSignal): Promise<boolean>;
}

export function createEscrowReadinessHealthCheck(options: {
  readonly readiness: (signal: AbortSignal) => Promise<EscrowReadinessReport>;
  readonly now: () => number;
  readonly cacheTtlMs: number;
  readonly failureCacheTtlMs: number;
  readonly probeTimeoutMs: number;
  readonly log: Pick<Logger, 'info' | 'warn'>;
}): EscrowReadinessHealthCheck {
  for (const [name, value] of [
    ['cache TTL', options.cacheTtlMs],
    ['failure cache TTL', options.failureCacheTtlMs],
    ['probe timeout', options.probeTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`escrow readiness ${name} must be a positive integer`);
    }
  }

  let cached: { readonly report: EscrowReadinessReport; readonly expiresAtMs: number } | null = null;
  let inFlight: Promise<EscrowReadinessReport> | null = null;
  let lastReportKey: string | null = null;

  const recordTransition = (report: EscrowReadinessReport): void => {
    const key = `${report.status}:${report.reasons.join(',')}`;
    if (key === lastReportKey) return;
    if (report.status === 'ready') {
      options.log.info('escrow_readiness_recovered');
    } else {
      options.log.warn('escrow_readiness_unavailable', { reasons: report.reasons });
    }
    lastReportKey = key;
  };

  const unavailable = (): EscrowReadinessReport => ({
    status: 'not_ready',
    reasons: ['readiness_probe_unavailable'],
  });

  const startProbe = (): Promise<EscrowReadinessReport> => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<EscrowReadinessReport>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(unavailable());
      }, options.probeTimeoutMs);
    });
    const task = Promise.race([options.readiness(controller.signal), timedOut]).then((report) => {
      if (timeout !== undefined) clearTimeout(timeout);
      recordTransition(report);
      const ttlMs = report.status === 'ready'
        ? options.cacheTtlMs
        : options.failureCacheTtlMs;
      cached = { report, expiresAtMs: options.now() + ttlMs };
      return report;
    }, (error: unknown) => {
      if (timeout !== undefined) clearTimeout(timeout);
      throw error;
    });
    const clear = (): void => {
      if (inFlight === task) inFlight = null;
    };
    void task.then(clear, clear);
    return task;
  };

  const waitForCaller = (
    task: Promise<EscrowReadinessReport>,
    signal: AbortSignal,
  ): Promise<EscrowReadinessReport> => new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    task.then(
      (report) => {
        cleanup();
        resolve(report);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });

  const inspect = async (signal: AbortSignal): Promise<EscrowReadinessReport> => {
    signal.throwIfAborted();
    if (cached !== null && options.now() < cached.expiresAtMs) return cached.report;
    if (inFlight === null) {
      inFlight = startProbe();
    }
    const report = await waitForCaller(inFlight, signal);
    signal.throwIfAborted();
    return report;
  };

  return {
    async check(signal) {
      return (await inspect(signal)).status === 'ready';
    },
  };
}
