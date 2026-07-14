import { z } from 'zod';

const PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;
const BASE64_TRANSACTION_PATTERN = /^[A-Za-z0-9+/]{1,2500}={0,2}$/;
const WalletRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(64), z.number().finite()]),
  method: z.enum([
    'getBalance',
    'getAccountInfo',
    'getTokenAccountBalance',
    'getLatestBlockhash',
    'sendTransaction',
    'getSignatureStatuses',
  ]),
  params: z.array(z.unknown()).max(2),
}).strict();

export type WalletRpcProxyResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly status: 400 | 502; readonly error: string };

export async function proxyWalletRpc(
  raw: unknown,
  options: { readonly rpcUrl: string; readonly fetchImpl?: typeof fetch },
): Promise<WalletRpcProxyResult> {
  const parsed = WalletRpcRequestSchema.safeParse(raw);
  if (!parsed.success || !validParams(parsed.data.method, parsed.data.params)) {
    return { ok: false, status: 400, error: 'invalid_rpc_request' };
  }
  try {
    const response = await (options.fetchImpl ?? fetch)(options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    });
    if (!response.ok) return { ok: false, status: 502, error: 'rpc_unavailable' };
    return { ok: true, response };
  } catch {
    return { ok: false, status: 502, error: 'rpc_unavailable' };
  }
}

function validParams(method: string, params: readonly unknown[]): boolean {
  switch (method) {
    case 'getBalance':
    case 'getAccountInfo':
    case 'getTokenAccountBalance':
      return params.length >= 1 && isPubkey(params[0]) && optionalConfig(params[1]);
    case 'getLatestBlockhash':
      return params.length <= 1 && optionalConfig(params[0]);
    case 'sendTransaction':
      return params.length >= 1 && typeof params[0] === 'string' &&
        BASE64_TRANSACTION_PATTERN.test(params[0]) && optionalConfig(params[1]);
    case 'getSignatureStatuses':
      return params.length >= 1 && Array.isArray(params[0]) && params[0].length === 1 &&
        typeof params[0][0] === 'string' && SIGNATURE_PATTERN.test(params[0][0]) &&
        optionalConfig(params[1]);
    default:
      return false;
  }
}

function isPubkey(value: unknown): boolean {
  return typeof value === 'string' && PUBKEY_PATTERN.test(value);
}

function optionalConfig(value: unknown): boolean {
  return value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value));
}
