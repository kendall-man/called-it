import { describe, expect, it } from 'vitest';
import { createSupabaseReadinessClient } from './readiness-supabase.js';

const OPTIONS = {
  baseUrl: 'https://database.test',
  serviceRoleKey: 'redacted-test-key',
};

describe('abortable Supabase readiness client', () => {
  it('reports whether the authoritative starter budget can issue another grant', async () => {
    // Given the singleton budget has reached its count and lamport caps
    let requestedUrl = '';
    const request: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify([{
        enabled: true,
        grant_lamports: 10_000_000,
        total_cap_lamports: 5_000_000_000,
        max_grants: 500,
        granted_lamports: 5_000_000_000,
        granted_count: 500,
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = createSupabaseReadinessClient({ ...OPTIONS, request });

    // When readiness reads the budget
    const budget = await client.starterBudget(new AbortController().signal);

    // Then intake is enabled but no additional starter can be admitted
    expect(budget).toEqual({ enabled: true, available: false });
    expect(new URL(requestedUrl).pathname).toBe('/rest/v1/wager_starter_budget');
  });

  it('propagates abort to an in-flight database probe', async () => {
    let observedSignal: AbortSignal | null | undefined;
    let cancellations = 0;
    const request: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        observedSignal = init?.signal;
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error('missing abort signal'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            cancellations += 1;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    const client = createSupabaseReadinessClient({ ...OPTIONS, request });
    const controller = new AbortController();

    const operation = client.probe(controller.signal);
    controller.abort(new Error('database probe cancelled'));

    await expect(operation).rejects.toThrow('database probe cancelled');
    expect(observedSignal).toBe(controller.signal);
    expect(cancellations).toBe(1);
  });

  it('cancels a response body that resolves after the probe was aborted', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    let bodyCancelled = false;
    const request: typeof fetch = () =>
      new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      });
    const client = createSupabaseReadinessClient({ ...OPTIONS, request });
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      },
    });

    const operation = client.probe(controller.signal);
    controller.abort(new Error('late database result'));
    resolveRequest?.(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(operation).rejects.toThrow('late database result');
    expect(bodyCancelled).toBe(true);
  });
});
