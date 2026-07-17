async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null || response.body.locked) return;
  await response.body.cancel();
}

function inheritedSignal(
  input: string | URL | Request,
  init: RequestInit | undefined,
): AbortSignal | null {
  if (init?.signal !== undefined && init.signal !== null) return init.signal;
  return input instanceof Request ? input.signal : null;
}

export function bindAbortSignalToFetch(
  request: typeof fetch,
  readinessSignal: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    readinessSignal.throwIfAborted();
    const existingSignal = inheritedSignal(input, init);
    const signal =
      existingSignal === null
        ? readinessSignal
        : AbortSignal.any([readinessSignal, existingSignal]);
    const response = await request(input, { ...init, signal });
    if (signal.aborted) {
      await cancelResponseBody(response);
      signal.throwIfAborted();
    }
    return response;
  };
}

export async function cancelUnusedResponse(response: Response): Promise<void> {
  await cancelResponseBody(response);
}
