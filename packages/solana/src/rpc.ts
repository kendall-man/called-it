/**
 * Retry wrapper for wager-path RPC calls against public devnet endpoints.
 *
 * api.devnet.solana.com rate-limits aggressively under polling, so every
 * chain call in the wager flows (deposit scans, withdrawal ticks, solvency
 * checks) goes through `withRetry` — a transient 429 or network blip must
 * never surface as a failed scan. `withRetry` itself rethrows the final
 * error after exhausting attempts; the domain functions in transfer.ts and
 * deposits.ts convert that into the house `{ ok: false, error }` shape.
 */

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 400;
const DEFAULT_MAX_DELAY_MS = 8_000;
/** A 429 signals server-side pressure — back off at least this long. */
const RATE_LIMIT_MIN_DELAY_MS = 2_000;
/** Jitter spreads concurrent retries across 0.5x–1.5x of the base delay. */
const JITTER_FLOOR = 0.5;
const HTTP_TOO_MANY_REQUESTS = 429;

export interface WithRetryOptions {
  /** Total attempts including the first call (default 4). */
  attempts?: number;
  /** First retry delay before jitter (default 400ms, doubled per attempt). */
  baseDelayMs?: number;
  /** Ceiling for the jittered delay (default 8s; the 429 floor may exceed it). */
  maxDelayMs?: number;
  /** Injectable for deterministic tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source returning [0, 1); defaults to Math.random. */
  random?: () => number;
  /** Observer for retry telemetry (attempt is 1-based). */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    rateLimited: boolean;
    error: unknown;
  }) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether an RPC failure is an HTTP 429. web3.js surfaces these as plain
 * Errors whose message embeds the status line ("429 Too Many Requests");
 * fetch-level wrappers may carry a numeric status field instead.
 */
export function isRateLimitError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const withStatus = error as { status?: unknown; statusCode?: unknown };
    if (
      withStatus.status === HTTP_TOO_MANY_REQUESTS ||
      withStatus.statusCode === HTTP_TOO_MANY_REQUESTS
    ) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(String(HTTP_TOO_MANY_REQUESTS)) || /too many requests/i.test(message);
}

/**
 * Run `operation`, retrying on any failure with jittered exponential
 * backoff. Rate-limit (429) failures always wait at least
 * {@link RATE_LIMIT_MIN_DELAY_MS} regardless of the computed backoff.
 * Rethrows the last error once attempts are exhausted.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const rateLimited = isRateLimitError(error);
      const exponential = baseDelayMs * 2 ** (attempt - 1);
      const jittered = Math.min(exponential, maxDelayMs) * (JITTER_FLOOR + random());
      // The 429 floor wins over the ceiling: server pressure beats impatience.
      const delayMs = Math.round(
        rateLimited ? Math.max(jittered, RATE_LIMIT_MIN_DELAY_MS) : jittered,
      );
      options.onRetry?.({ attempt, delayMs, rateLimited, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
