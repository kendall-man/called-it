import { NextResponse } from 'next/server';
import { createWalletChallenge } from '@/lib/wallet-link-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  try {
    const result = await createWalletChallenge(body);
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { error: 'wallet_service_unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
