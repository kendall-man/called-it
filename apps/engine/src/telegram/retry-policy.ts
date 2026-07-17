export class TelegramRetryPolicyError extends Error {
  readonly name = 'TelegramRetryPolicyError';

  constructor(message: string) {
    super(message);
  }
}

export function computeTelegramRetryDelayMs(input: {
  readonly attempt: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly randomValue: number;
}): number {
  const { attempt, retryBaseMs, retryMaxMs, randomValue } = input;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TelegramRetryPolicyError('attempt must be a positive integer');
  }
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1) {
    throw new TelegramRetryPolicyError('retryBaseMs must be a positive integer');
  }
  if (!Number.isSafeInteger(retryMaxMs) || retryMaxMs < retryBaseMs) {
    throw new TelegramRetryPolicyError('retryMaxMs must be a positive integer not below retryBaseMs');
  }
  if (Number.isNaN(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new TelegramRetryPolicyError('randomValue must be between 0 and 1');
  }

  const cap = cappedExponentialDelay(attempt, retryBaseMs, retryMaxMs);
  const floor = Math.ceil(cap / 2);
  return Math.min(cap, floor + Math.floor(randomValue * (cap - floor + 1)));
}

export function computeTelegramRetryAtMs(input: {
  readonly nowMs: number;
  readonly attempt: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly randomValue: number;
}): number {
  const { nowMs, ...policy } = input;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TelegramRetryPolicyError('nowMs must be a non-negative integer');
  }
  return nowMs + computeTelegramRetryDelayMs(policy);
}

function cappedExponentialDelay(attempt: number, retryBaseMs: number, retryMaxMs: number): number {
  let cap = retryBaseMs;
  for (let index = 1; index < attempt && cap < retryMaxMs; index += 1) {
    cap = Math.min(retryMaxMs, cap * 2);
  }
  return cap;
}
