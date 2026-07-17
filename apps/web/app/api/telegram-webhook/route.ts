import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const origin = process.env.ENGINE_INTERNAL_ORIGIN;
  if (!origin) return NextResponse.json({ error: 'engine_unavailable' }, { status: 503 });

  const response = await fetch(`${origin}/api/telegram-webhook`, {
    method: 'POST',
    headers: {
      'content-type': request.headers.get('content-type') ?? 'application/json',
      'x-telegram-bot-api-secret-token':
        request.headers.get('x-telegram-bot-api-secret-token') ?? '',
    },
    body: await request.text(),
    cache: 'no-store',
  });
  return new Response(response.body, { status: response.status });
}
