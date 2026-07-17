import type { FetchFn } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createTimedSolanaFetch } from './solana-rpc.js';

describe('escrow Solana RPC transport', () => {
  it('aborts a stalled request at the configured deadline', async () => {
    const observed: { signal?: AbortSignal } = {};
    const stalled = (async (_input, init) => {
      if (init?.signal !== undefined && init.signal !== null) observed.signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        observed.signal?.addEventListener('abort', () => reject(observed.signal?.reason), { once: true });
      });
    }) as FetchFn;

    await expect(createTimedSolanaFetch(5, stalled)('https://rpc.invalid'))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(observed.signal?.aborted).toBe(true);
  });

  it('rejects invalid timeout configuration', () => {
    expect(() => createTimedSolanaFetch(0)).toThrow('positive integer');
  });
});
