import { NextResponse } from 'next/server';
import { prepareEscrowPosition } from '@/lib/position-server';
import { readPrivyBearerToken } from '@/lib/privy-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const accessToken = readPrivyBearerToken(request.headers.get('authorization'));
  if (accessToken === null) return response(401, { error: 'privy_auth_required' });
  try {
    const result = await prepareEscrowPosition(await requestBody(request), accessToken);
    return response(result.status, result.body);
  } catch {
    return response(503, { error: 'sponsor_unavailable' });
  }
}
async function requestBody(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}

function response(status: number, body: Readonly<Record<string, unknown>>): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
