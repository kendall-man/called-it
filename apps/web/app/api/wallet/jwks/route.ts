import { NextResponse } from 'next/server';
import { walletAuthJwks } from '@/lib/wallet-auth-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(walletAuthJwks(), {
      headers: { 'cache-control': 'public, max-age=300, stale-while-revalidate=300' },
    });
  } catch {
    return NextResponse.json(
      { error: 'wallet_service_unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
