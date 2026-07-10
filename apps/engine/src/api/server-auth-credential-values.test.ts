import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_ID,
  CONCIERGE_TOKEN,
  closeActiveServer,
  startHarness,
} from './server-test-harness.js';

type RawResponse = {
  readonly status: number;
  readonly text: string;
};

async function sendHttp(
  base: string,
  options: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  },
): Promise<RawResponse> {
  const url = new URL(options.path, base);
  const bodyBuffer = options.body === undefined ? undefined : Buffer.from(options.body);
  const headers = bodyBuffer === undefined
    ? options.headers
    : {
        ...options.headers,
        'content-length': String(bodyBuffer.byteLength),
      };
  return await new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        method: options.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (bodyBuffer !== undefined) req.write(bodyBuffer);
    req.end();
  });
}

function authedJson(token: string): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

describe('engine credential value transport boundary', () => {
  afterEach(closeActiveServer);

  it('rejects known route tokens carried under innocuous query values on public, protected, and unknown routes', async () => {
    const harness = await startHarness();
    const encodedToken = encodeURIComponent(CONCIERGE_TOKEN);
    const cases = [
      `/api/live?note=${encodedToken}`,
      `/api/fixtures?note=benign&note=${encodedToken}`,
      `/api/not-real?filters%5B0%5D%5Bvalue%5D=${encodedToken}`,
    ] as const;

    const publicResponse = await sendHttp(harness.base, {
      method: 'GET',
      path: cases[0],
    });
    const protectedResponse = await sendHttp(harness.base, {
      method: 'GET',
      path: cases[1],
      headers: { authorization: `Bearer ${CONCIERGE_TOKEN}` },
    });
    const unknownResponse = await sendHttp(harness.base, {
      method: 'GET',
      path: cases[2],
    });

    expect(publicResponse.status).toBe(401);
    expect(protectedResponse.status).toBe(401);
    expect(unknownResponse.status).toBe(401);
    expect(publicResponse.text).toBe('{"error":"unauthorized"}');
    expect(protectedResponse.text).toBe('{"error":"unauthorized"}');
    expect(unknownResponse.text).toBe('{"error":"unauthorized"}');
  });

  it('rejects known route tokens carried inside parsed GET and POST JSON bodies', async () => {
    const harness = await startHarness();
    const nestedTokenBody = JSON.stringify({
      metadata: [{ note: 'benign' }, { note: CONCIERGE_TOKEN }],
    });
    const publicResponse = await sendHttp(harness.base, {
      method: 'GET',
      path: '/api/live',
      headers: { 'content-type': 'application/json' },
      body: nestedTokenBody,
    });
    const protectedGetResponse = await sendHttp(harness.base, {
      method: 'GET',
      path: '/api/fixtures',
      headers: authedJson(CONCIERGE_TOKEN),
      body: nestedTokenBody,
    });
    const protectedPostResponse = await sendHttp(harness.base, {
      method: 'POST',
      path: '/api/quote',
      headers: authedJson(CONCIERGE_TOKEN),
      body: JSON.stringify({
        chatId: CHAT_ID,
        text: 'Spain win',
        proof: { signature: 'safe-signature' },
        metadata: { entries: [{ note: CONCIERGE_TOKEN }] },
      }),
    });
    const unknownResponse = await sendHttp(harness.base, {
      method: 'POST',
      path: '/api/not-real',
      headers: { 'content-type': 'application/json' },
      body: nestedTokenBody,
    });

    expect(publicResponse.status).toBe(401);
    expect(protectedGetResponse.status).toBe(401);
    expect(protectedPostResponse.status).toBe(401);
    expect(unknownResponse.status).toBe(401);
  });

  it('keeps non-token proof payload strings working on the quote route', async () => {
    const harness = await startHarness();

    const response = await sendHttp(harness.base, {
      method: 'POST',
      path: '/api/quote',
      headers: authedJson(CONCIERGE_TOKEN),
      body: JSON.stringify({
        chatId: CHAT_ID,
        text: 'Spain win',
        signature: 'proof-signature',
        signedMessage: 'proof-message',
        wallet: 'public-wallet',
        metadata: { note: 'not-a-route-token' },
      }),
    });

    expect(response.status).toBe(200);
  });

  it('treats malformed JSON explicitly and does not promote it into credential auth', async () => {
    const harness = await startHarness();

    const response = await sendHttp(harness.base, {
      method: 'POST',
      path: '/api/quote',
      headers: authedJson(CONCIERGE_TOKEN),
      body: `{"chatId":${CHAT_ID},"text":"Spain win","note":"${CONCIERGE_TOKEN}"`,
    });

    expect(response.status).toBe(400);
  });
});
