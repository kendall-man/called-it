import type { EscrowAsset } from '@calledit/db';
import { EscrowReconciliationError } from './reconciler.js';

export interface EscrowPeriodicReconciliationLink {
  readonly marketId: string;
  readonly custodyMode: 'escrow';
  readonly marketPda: string;
  readonly vaultPda: string;
  readonly asset: EscrowAsset;
}

export interface EscrowPeriodicReconciliationLinkPort {
  listReconciliationLinks(input: {
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<{
    readonly links: readonly EscrowPeriodicReconciliationLink[];
    readonly nextCursor: string | null;
  }>;
}

export interface EscrowPeriodicReconcilePort {
  reconcile(link: EscrowPeriodicReconciliationLink): Promise<{
    readonly status: 'in_sync' | 'drift';
  }>;
}

export interface EscrowPeriodicReconciliationLog {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface EscrowPeriodicReconciliationRunResult {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly sweepComplete: boolean;
}

export interface EscrowPeriodicReconciliationRunner {
  start(): void;
  runOnce(): Promise<EscrowPeriodicReconciliationRunResult>;
  stopLeasing(): void;
  drain(signal: AbortSignal): Promise<void>;
  unfinished(): number;
}

class EscrowPeriodicReconciliationPageError extends Error {
  readonly name = 'EscrowPeriodicReconciliationPageError';
}

const SKIPPED_RESULT: EscrowPeriodicReconciliationRunResult = {
  attempted: 0,
  succeeded: 0,
  failed: 0,
  sweepComplete: false,
};

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validatePage(
  value: {
    readonly links: readonly EscrowPeriodicReconciliationLink[];
    readonly nextCursor: string | null;
  },
  cursor: string | null,
  batchSize: number,
): void {
  if (
    !Array.isArray(value.links) || value.links.length > batchSize ||
    (value.nextCursor !== null && !nonempty(value.nextCursor)) ||
    (value.nextCursor !== null && value.nextCursor === cursor)
  ) {
    throw new EscrowPeriodicReconciliationPageError();
  }
  const marketIds = new Set<string>();
  for (const link of value.links) {
    if (
      !nonempty(link.marketId) || !nonempty(link.marketPda) || !nonempty(link.vaultPda) ||
      link.custodyMode !== 'escrow' || (link.asset !== 'sol' && link.asset !== 'usdc') ||
      marketIds.has(link.marketId)
    ) {
      throw new EscrowPeriodicReconciliationPageError();
    }
    marketIds.add(link.marketId);
  }
}

function reconciliationFailureCode(error: unknown): string {
  return error instanceof EscrowReconciliationError ? error.code : 'reconcile_failed';
}

function waitForWork(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    void work.then(finish, finish);
  });
}

export function createEscrowPeriodicReconciliationRunner(options: {
  readonly links: EscrowPeriodicReconciliationLinkPort;
  readonly reconciler: EscrowPeriodicReconcilePort;
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly log: EscrowPeriodicReconciliationLog;
}): EscrowPeriodicReconciliationRunner {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) {
    throw new TypeError('escrow reconciliation batch size must be a positive integer');
  }
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new TypeError('escrow reconciliation interval must be a positive integer');
  }

  let accepting = true;
  let started = false;
  let cursor: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<EscrowPeriodicReconciliationRunResult> | null = null;

  async function cycle(): Promise<EscrowPeriodicReconciliationRunResult> {
    let page: Awaited<ReturnType<EscrowPeriodicReconciliationLinkPort['listReconciliationLinks']>>;
    try {
      page = await options.links.listReconciliationLinks({
        cursor,
        limit: options.batchSize,
      });
      validatePage(page, cursor, options.batchSize);
    } catch (error) {
      options.log.warn('escrow_periodic_reconciliation_list_failed', {
        code: error instanceof EscrowPeriodicReconciliationPageError ? 'invalid_page' : 'list_failed',
      });
      return SKIPPED_RESULT;
    }

    let succeeded = 0;
    let failed = 0;
    for (const link of page.links) {
      try {
        const result = await options.reconciler.reconcile(link);
        succeeded += 1;
        if (result.status === 'drift') {
          options.log.warn('escrow_periodic_reconciliation_drift', {
            marketId: link.marketId,
            code: 'vault_liability_drift',
          });
        }
      } catch (error) {
        failed += 1;
        options.log.warn('escrow_periodic_reconciliation_market_failed', {
          marketId: link.marketId,
          code: reconciliationFailureCode(error),
        });
      }
    }

    cursor = page.nextCursor;
    const result = {
      attempted: page.links.length,
      succeeded,
      failed,
      sweepComplete: page.nextCursor === null,
    };
    options.log.info('escrow_periodic_reconciliation_cycle_complete', result);
    return result;
  }

  function schedule(): void {
    if (!accepting || !started || timer !== null || active !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void beginCycle();
    }, options.intervalMs);
  }

  function beginCycle(): Promise<EscrowPeriodicReconciliationRunResult> {
    if (!accepting) return Promise.resolve(SKIPPED_RESULT);
    if (active !== null) return active;
    active = cycle().finally(() => {
      active = null;
      schedule();
    });
    return active;
  }

  function stopLeasing(): void {
    if (!accepting) return;
    accepting = false;
    started = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    options.log.info('escrow_periodic_reconciliation_stopped');
  }

  return {
    start() {
      if (started || !accepting) return;
      started = true;
      options.log.info('escrow_periodic_reconciliation_started');
      void beginCycle();
    },
    runOnce() {
      return beginCycle();
    },
    stopLeasing,
    async drain(signal) {
      stopLeasing();
      while (active !== null && !signal.aborted) {
        await waitForWork(active, signal);
      }
    },
    unfinished() {
      return active === null ? 0 : 1;
    },
  };
}
