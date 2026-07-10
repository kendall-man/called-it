import { createConnection } from 'node:net';
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../log.js';
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

type RequestHeaders = OutgoingHttpHeaders | readonly string[];

function captureWarnings(logs: unknown[]): Logger {
  return {
    info: () => undefined,
    warn: (event, fields) => logs.push({ event, fields }),
    error: (event, fields) => logs.push({ event, fields }),
    child: () => captureWarnings(logs),
  };
}

async function sendHttp(
  base: string,
  options: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly headers?: RequestHeaders;
    readonly body?: string;
  },
): Promise<RawResponse> {
  const url = new URL(options.path, base);
  const bodyBuffer = options.body === undefined ? undefined : Buffer.from(options.body);
  const headers = withContentLength(options.headers, bodyBuffer?.byteLength);
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

async function sendRawHttp(base: string, requestText: string): Promise<RawResponse> {
  const url = new URL(base);
  return await new Promise<RawResponse>((resolve, reject) => {
    const socket = createConnection(
      { host: url.hostname, port: Number(url.port) },
      () => socket.end(requestText),
    );
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    socket.on('error', reject);
    socket.on('end', () => {
      const response = Buffer.concat(chunks).toString('utf8');
      const [rawHead = '', body = ''] = response.split('\r\n\r\n');
      const status = Number(rawHead.split('\r\n')[0]?.split(' ')[1] ?? 0);
      resolve({ status, text: body });
    });
  });
}

function withContentLength(
  headers: RequestHeaders | undefined,
  bodyLength: number | undefined,
): RequestHeaders | undefined {
  if (bodyLength === undefined) return headers;
  if (headers === undefined) return { 'content-length': String(bodyLength) };
  if (Array.isArray(headers)) {
    return [...headers, 'content-length', String(bodyLength)];
  }
  return {
    ...headers,
    'content-length': String(bodyLength),
  };
}

describe('engine auth boundary hardening', () => {
  afterEach(closeActiveServer);

  it('keeps canonical Bearer credentials working for protected routes', async () => {
    // Given the current canonical auth header shape
    const harness = await startHarness();

    // When the caller requests a protected route with that header
    const response = await sendHttp(harness.base, {
      method: 'GET',
      path: `/api/groups/${CHAT_ID}/snapshot`,
      headers: { authorization: `Bearer ${CONCIERGE_TOKEN}` },
    });

    // Then the long-standing protected route behavior still works
    expect(response.status).toBe(200);
  });

  it('accepts a lower-case bearer scheme on protected routes', async () => {
    const harness = await startHarness();

    const response = await sendHttp(harness.base, {
      method: 'GET',
      path: `/api/groups/${CHAT_ID}/snapshot`,
      headers: { authorization: `bearer ${CONCIERGE_TOKEN}` },
    });

    expect(response.status).toBe(200);
  });

  it('fails closed on duplicate Authorization headers without reflecting secrets', async () => {
    const logs: unknown[] = [];
    const harness = await startHarness({ log: captureWarnings(logs) });
    const acceptedToken = CONCIERGE_TOKEN;
    const rejectedToken = 'duplicate-header-secret-token';
    const url = new URL(harness.base);

    const response = await sendRawHttp(
      harness.base,
      [
        `GET /api/groups/${CHAT_ID}/snapshot HTTP/1.1`,
        `Host: ${url.host}`,
        `Authorization: Bearer ${acceptedToken}`,
        `Authorization: Bearer ${rejectedToken}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );

    expect(response.status).toBe(401);
    expect(response.text).toBe('{"error":"unauthorized"}');
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(acceptedToken);
    expect(serializedLogs).not.toContain(rejectedToken);
  });

  it('rejects credential query transport on public and unknown routes without echoing values', async () => {
    const logs: unknown[] = [];
    const harness = await startHarness({ log: captureWarnings(logs) });
    const liveSecret = 'public-query-secret-token';
    const unknownSecret = 'unknown-query-secret-token';

    const live = await sendHttp(harness.base, {
      method: 'GET',
      path: `/api/live?token=${liveSecret}`,
    });
    const unknown = await sendHttp(harness.base, {
      method: 'GET',
      path: `/api/not-real?access_token=${unknownSecret}`,
    });

    expect(live.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(live.text).not.toContain(liveSecret);
    expect(unknown.text).not.toContain(unknownSecret);
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(liveSecret);
    expect(serializedLogs).not.toContain(unknownSecret);
  });

  it('rejects credential JSON bodies on public, protected GET, and unknown routes', async () => {
    const logs: unknown[] = [];
    const harness = await startHarness({ log: captureWarnings(logs) });
    const publicSecret = 'public-body-secret-token';
    const protectedSecret = 'protected-body-secret-token';
    const unknownSecret = 'unknown-body-secret-token';

    const publicRoute = await sendHttp(harness.base, {
      method: 'GET',
      path: '/api/live',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: publicSecret }),
    });
    const protectedRoute = await sendHttp(harness.base, {
      method: 'GET',
      path: '/api/fixtures',
      headers: {
        authorization: `Bearer ${CONCIERGE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: protectedSecret }),
    });
    const unknownRoute = await sendHttp(harness.base, {
      method: 'GET',
      path: '/api/not-real',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: unknownSecret }),
    });

    expect(publicRoute.status).toBe(401);
    expect(protectedRoute.status).toBe(401);
    expect(unknownRoute.status).toBe(401);
    expect(publicRoute.text).not.toContain(publicSecret);
    expect(protectedRoute.text).not.toContain(protectedSecret);
    expect(unknownRoute.text).not.toContain(unknownSecret);
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(publicSecret);
    expect(serializedLogs).not.toContain(protectedSecret);
    expect(serializedLogs).not.toContain(unknownSecret);
  });
});
