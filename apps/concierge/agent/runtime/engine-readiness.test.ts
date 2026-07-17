import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHttpEngineReadinessPort } from './engine-readiness.js';

let activeServer: Server | null = null;

class TestServerAddressError extends Error {
  readonly name = 'TestServerAddressError';
}

afterEach(() => {
  activeServer?.close();
  activeServer = null;
});

describe('concierge engine readiness port', () => {
  it('maps a valid private engine 503 contract without sending credentials', async () => {
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'not_ready', reasons: ['feed_stale'] }));
    });
    activeServer = server;
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new TestServerAddressError('test server did not bind a TCP port');
    }
    const port = createHttpEngineReadinessPort({
      baseUrl: `http://127.0.0.1:${address.port}`,
      request: fetch,
    });

    const result = await port.probe(new AbortController().signal);

    expect(result).toBe('not_ready');
    expect(requests).toEqual([{ url: '/api/ready', authorization: undefined }]);
  });
});
