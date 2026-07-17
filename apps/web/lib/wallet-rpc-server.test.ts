import { describe, expect, it, vi } from 'vitest';
import { proxyWalletRpc } from './wallet-rpc-server';

const PUBKEY = '38yotsncGgsKd7TDm7iusvAtQXib7iCykdouuzjvFxnk';

describe('wallet RPC bridge', () => {
  it('forwards only the allowlisted wallet request shape', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ jsonrpc: '2.0', id: 1, result: { value: 0 } }),
    );
    const result = await proxyWalletRpc(
      { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [PUBKEY, { commitment: 'confirmed' }] },
      { rpcUrl: 'https://rpc.example.test', fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('blocks arbitrary RPC methods and malformed transaction payloads', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect((await proxyWalletRpc(
      { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [] },
      { rpcUrl: 'https://rpc.example.test', fetchImpl },
    )).ok).toBe(false);
    expect((await proxyWalletRpc(
      { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: ['not base64'] },
      { rpcUrl: 'https://rpc.example.test', fetchImpl },
    )).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['getGenesisHash', []],
    ['getBlockHeight', [{ commitment: 'confirmed' }]],
    ['isBlockhashValid', ['11111111111111111111111111111111', { commitment: 'confirmed' }]],
  ])('allows the read-only escrow verification method %s', async (method, params) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ jsonrpc: '2.0', id: 1, result: true }),
    );
    const result = await proxyWalletRpc(
      { jsonrpc: '2.0', id: 1, method, params },
      { rpcUrl: 'https://rpc.example.test', fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
