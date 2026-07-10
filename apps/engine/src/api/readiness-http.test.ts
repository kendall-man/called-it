import { describe, expect, it } from 'vitest';
import { bindAbortSignalToFetch } from './readiness-http.js';

describe('abort-bound readiness fetch', () => {
  it('passes the readiness signal into the real request and cancels it', async () => {
    let observedSignal: AbortSignal | null | undefined;
    const request: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        observedSignal = init?.signal;
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error('missing abort signal'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const controller = new AbortController();
    const bound = bindAbortSignalToFetch(request, controller.signal);

    const operation = bound('https://txline.test/api/odds/snapshot/1');
    controller.abort(new Error('readiness cancelled'));

    await expect(operation).rejects.toThrow('readiness cancelled');
    expect(observedSignal).toBe(controller.signal);
  });
});
