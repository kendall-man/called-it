import { NextResponse } from 'next/server';
import { loadWebEnv } from '@/lib/env';
import { proxyWalletRpc } from '@/lib/wallet-rpc-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  let rpcUrl: string | undefined;
  try {
    rpcUrl = loadWebEnv().SOLANA_RPC_URL;
  } catch {
    rpcUrl = undefined;
  }
  if (rpcUrl === undefined) {
    return NextResponse.json(
      { error: 'rpc_unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
  const result = await proxyWalletRpc(body, { rpcUrl });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status, headers: { 'cache-control': 'no-store' } },
    );
  }
  return new Response(await result.response.arrayBuffer(), {
    status: result.response.status,
    headers: {
      'cache-control': 'no-store',
      'content-type': result.response.headers.get('content-type') ?? 'application/json',
    },
  });
}
