import { NextResponse } from 'next/server';
import { openMiniAppWalletSession } from '@/lib/miniapp-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const body = await requestBody(request);
  try {
    const result = await openMiniAppWalletSession(body);
    return response(result.status, result.body);
  } catch (cause) {
    console.error('wallet_open_unavailable', {
      message: cause instanceof Error ? cause.message : 'unknown_error',
    });
    return response(503, { error: 'sponsor_unavailable' });
  }
}

async function requestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function response(status: number, body: Readonly<Record<string, unknown>>): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
