const RETRYABLE_POLLING_CONFLICT_MESSAGE = 'telegram polling overlap; retrying';

function isPollingConflict(method: string, error: unknown): boolean {
  return method === 'getUpdates'
    && typeof error === 'object'
    && error !== null
    && 'error_code' in error
    && error.error_code === 409;
}

function retryableConflict(): Error {
  return new Error(RETRYABLE_POLLING_CONFLICT_MESSAGE);
}

/**
 * grammY retries ordinary fetch failures but treats Telegram 409 as fatal.
 * During a Railway rolling deploy, the old and new pollers overlap briefly,
 * so remove only that classification and let grammY's bounded backoff retry.
 */
export async function withRetryablePollingConflict<Result>(
  method: string,
  operation: () => Promise<Result>,
  onConflict: () => void,
): Promise<Result> {
  try {
    const result = await operation();
    if (isPollingConflict(method, result)) {
      onConflict();
      throw retryableConflict();
    }
    return result;
  } catch (error) {
    if (!isPollingConflict(method, error)) throw error;
    onConflict();
    throw retryableConflict();
  }
}
