import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../log.js';
import {
  CHAT_ID,
  CONCIERGE_TOKEN,
  TELEGRAM_TOKEN,
  OPS_TOKEN,
  closeActiveServer,
  startHarness,
} from './server-test-harness.js';

const jsonHeaders = { 'content-type': 'application/json' };
const CREDENTIAL_NAMES = [
  'apiToken',
  'access_token',
  'engine-token',
  'bearer',
  'authorization',
  'initData',
  'signature',
  'signedMessage',
  'wallet',
  'privateKey',
] as const;

function captureWarnings(logs: unknown[]): Logger {
  return {
    info: () => undefined,
    warn: (event, fields) => logs.push({ event, fields }),
    error: (event, fields) => logs.push({ event, fields }),
    child: () => captureWarnings(logs),
  };
}

function bearer(token: string): Record<string, string> {
  return { ...jsonHeaders, authorization: `Bearer ${token}` };
}

describe('engine route-scoped credentials', () => {
  afterEach(closeActiveServer);

  it('exposes only liveness and readiness without credentials', async () => {
    const harness = await startHarness();

    const live = await fetch(`${harness.base}/api/live`);
    const ready = await fetch(`${harness.base}/api/ready`);
    const legacy = await fetch(`${harness.base}/api/health`);

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(legacy.status).toBe(404);
  });

  it('separates missing, unknown, wrong-scope, and matching credentials', async () => {
    const harness = await startHarness();
    const snapshot = `${harness.base}/api/groups/${CHAT_ID}/snapshot`;

    const missing = await fetch(snapshot);
    const unknown = await fetch(snapshot, { headers: bearer('not-a-known-route-token') });
    const wrongScope = await fetch(snapshot, { headers: bearer(TELEGRAM_TOKEN) });
    const matching = await fetch(snapshot, { headers: bearer(CONCIERGE_TOKEN) });

    expect(missing.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongScope.status).toBe(403);
    expect(matching.status).toBe(200);
  });

  it('allows only the operations token to read operations status', async () => {
    const harness = await startHarness();
    const path = `${harness.base}/api/ops/status`;

    const wrongScope = await fetch(path, { headers: bearer(CONCIERGE_TOKEN) });
    const matching = await fetch(path, { headers: bearer(OPS_TOKEN) });

    expect(wrongScope.status).toBe(403);
    expect(matching.status).toBe(200);
    expect(await matching.json()).toEqual({
      status: 'ready',
      reasons: [],
      draining: false,
    });
  });

  it('keeps the concierge token away from Telegram ingress and direct stake mutation', async () => {
    const harness = await startHarness({
      handleTelegramUpdate: async () => undefined,
    });

    const ingress = await fetch(`${harness.base}/api/telegram-ingress`, {
      method: 'POST',
      headers: bearer(CONCIERGE_TOKEN),
      body: JSON.stringify({ update_id: 1 }),
    });
    const removedStakeRoute = '/api/' + 'stake';
    const stake = await fetch(`${harness.base}${removedStakeRoute}`, {
      method: 'POST',
      headers: bearer(CONCIERGE_TOKEN),
      body: JSON.stringify({}),
    });

    expect(ingress.status).toBe(403);
    expect(stake.status).toBe(404);
  });

  it('rejects credentials carried in query strings or JSON bodies', async () => {
    const harness = await startHarness();
    const credentialQueryName = 'token';

    const query = await fetch(`${harness.base}/api/fixtures?${credentialQueryName}=leaked`, {
      headers: bearer(CONCIERGE_TOKEN),
    });
    const body = await fetch(`${harness.base}/api/quote`, {
      method: 'POST',
      headers: bearer(CONCIERGE_TOKEN),
      body: JSON.stringify({
        chatId: CHAT_ID,
        text: 'Spain win',
        authorization: `Bearer ${CONCIERGE_TOKEN}`,
      }),
    });

    expect(query.status).toBe(401);
    expect(body.status).toBe(401);
  });

  it.each(CREDENTIAL_NAMES)('rejects normalized credential query key %s', async (name) => {
    // Given a valid route credential and a credential-like query parameter
    const harness = await startHarness();
    const url = new URL('/api/fixtures', harness.base);
    url.searchParams.set(name, 'credential-material');

    // When the caller sends the request
    const response = await fetch(url, { headers: bearer(CONCIERGE_TOKEN) });

    // Then authentication fails before route handling
    expect(response.status).toBe(401);
  });

  it.each(CREDENTIAL_NAMES)('rejects nested credential body key %s', async (name) => {
    // Given credential material is hidden in a nested object inside an array
    const harness = await startHarness();
    const body = {
      chatId: CHAT_ID,
      text: 'Spain win',
      metadata: { entries: [{ [name]: 'credential-material' }] },
    };

    // When the caller submits the quote request
    const response = await fetch(`${harness.base}/api/quote`, {
      method: 'POST',
      headers: bearer(CONCIERGE_TOKEN),
      body: JSON.stringify(body),
    });

    // Then authentication fails before parsing the domain payload
    expect(response.status).toBe(401);
  });

  it('allows benign domain keys that resemble credential names', async () => {
    // Given query and body metadata describe domain state rather than credentials
    const harness = await startHarness();
    const fixtures = new URL('/api/fixtures', harness.base);
    fixtures.searchParams.set('tokenSymbol', 'SOL');
    fixtures.searchParams.set('walletAddress', 'public-address');
    fixtures.searchParams.set('marketKey', 'market-reference');
    fixtures.searchParams.set('signatureRequired', 'false');

    // When callers send both read and quote requests
    const queryResponse = await fetch(fixtures, { headers: bearer(CONCIERGE_TOKEN) });
    const bodyResponse = await fetch(`${harness.base}/api/quote`, {
      method: 'POST',
      headers: bearer(CONCIERGE_TOKEN),
      body: JSON.stringify({
        chatId: CHAT_ID,
        text: 'Spain win',
        metadata: {
          tokenSymbol: 'SOL',
          walletAddress: 'public-address',
          marketKey: 'market-reference',
          signatureRequired: false,
        },
      }),
    });

    // Then both requests reach normal domain handling
    expect(queryResponse.status).toBe(200);
    expect(bodyResponse.status).toBe(200);
  });

  it('returns a safe 400 for malformed JSON without logging request text', async () => {
    // Given malformed JSON containing credential-shaped text
    const logs: unknown[] = [];
    const secret = 'malformed-json-secret-token';
    const harness = await startHarness({ log: captureWarnings(logs) });

    // When the caller submits it to a JSON body route
    const response = await fetch(`${harness.base}/api/quote`, {
      method: 'POST',
      headers: bearer(CONCIERGE_TOKEN),
      body: `{"chatId":${CHAT_ID},"text":"Spain win","authorization":"${secret}"`,
    });

    // Then the API preserves the safe bad-request behavior and logs no input
    expect(response.status).toBe(400);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it('redacts parser exception text when quote parsing is unavailable', async () => {
    // Given the parser throws a secret-bearing Error
    const logs: unknown[] = [];
    const secret = 'quote-parser-secret-token';
    const harness = await startHarness({
      log: captureWarnings(logs),
      parse: async () => {
        throw new Error(`provider failed with Authorization: Bearer ${secret}`);
      },
    });

    // When a live quote request reaches the parser
    const response = await fetch(`${harness.base}/api/quote`, {
      method: 'POST',
      headers: bearer(CONCIERGE_TOKEN),
      body: JSON.stringify({ chatId: CHAT_ID, text: 'Spain win this easy' }),
    });

    // Then callers see only the stable failure and logs contain no exception text
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'parse_unavailable' });
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).toContain('api_quote_parse_failed');
    expect(serializedLogs).toContain('parse_exception');
    expect(serializedLogs).not.toContain(secret);
    expect(serializedLogs).not.toContain('Authorization');
  });
});
