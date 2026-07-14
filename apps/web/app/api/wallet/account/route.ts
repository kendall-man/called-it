import { NextResponse } from 'next/server';
import { getWalletAccountSummary } from '@/lib/wallet-account-server';
import { readPrivyBearerToken } from '@/lib/privy-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const accessToken = readPrivyBearerToken(request.headers.get('authorization'));
  if (accessToken === null) {
    return NextResponse.json(
      { error: 'privy_auth_required' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  try {
    const result = await getWalletAccountSummary(body, accessToken);
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
