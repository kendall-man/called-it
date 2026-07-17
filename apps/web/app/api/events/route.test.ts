import { describe, expect, it } from 'vitest';
import { handleEntryEvent } from './handler';

const ENDPOINT = 'https://calledit.example.test/api/events';
const SAME_ORIGIN = 'https://calledit.example.test';
const EVENT = {
  eventName: 'entry_viewed',
  sessionId: '4a00dc06-feb4-4655-998f-3ca48b0b7248',
  idempotencyKey: '2f49b995-ed05-4e56-8c82-7397ca9d3371',
};

function eventRequest(
  body: unknown,
  options: { origin?: string; contentType?: string; host?: string } = {},
): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': options.contentType ?? 'application/json',
      ...(options.origin === undefined ? { origin: SAME_ORIGIN } : { origin: options.origin }),
      ...(options.host === undefined ? {} : { host: options.host }),
    },
    body: JSON.stringify(body),
  });
}

describe('anonymous entry events', () => {
  it.each(['entry_viewed', 'add_group_clicked'] as const)(
    'accepts %s as an unavailable anonymous no-op',
    async (eventName) => {
      // Given
      const recentEvents = new Set<string>();

      // When
      const response = await handleEntryEvent(eventRequest({ ...EVENT, eventName }), recentEvents);

      // Then
      expect(response.status).toBe(202);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.json()).resolves.toEqual({
        status: 'unavailable',
        ingested: false,
        duplicate: false,
      });
    },
  );

  it('accepts the browser origin when Next canonicalizes the request URL host', async () => {
    // Given a local request whose public Host is different from Next's internal URL host
    const request = new Request('http://localhost:3021/api/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3021',
        host: '127.0.0.1:3021',
      },
      body: JSON.stringify(EVENT),
    });

    // When
    const response = await handleEntryEvent(request, new Set<string>());

    // Then
    expect(response.status).toBe(202);
  });

  it.each([
    {
      name: 'a cross-origin request',
      request: eventRequest(EVENT, { origin: 'https://elsewhere.example.test' }),
      status: 403,
      body: { error: 'origin_forbidden' },
    },
    {
      name: 'a request without a JSON content type',
      request: eventRequest(EVENT, { contentType: 'text/plain' }),
      status: 400,
      body: { error: 'invalid_event' },
    },
    {
      name: 'an event outside the allowlist',
      request: eventRequest({ ...EVENT, eventName: 'receipt_opened' }),
      status: 400,
      body: { error: 'invalid_event' },
    },
    {
      name: 'an IP address or fingerprint field',
      request: eventRequest({ ...EVENT, ip: '203.0.113.1', fingerprint: 'browser-derived' }),
      status: 400,
      body: { error: 'invalid_event' },
    },
  ])('rejects $name', async ({ request, status, body }) => {
    const response = await handleEntryEvent(request, new Set<string>());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(body);
  });

  it('deduplicates a session and idempotency key without persisting the event', async () => {
    // Given
    const recentEvents = new Set<string>();

    // When
    const first = await handleEntryEvent(eventRequest(EVENT), recentEvents);
    const duplicate = await handleEntryEvent(eventRequest(EVENT), recentEvents);

    // Then
    await expect(first.json()).resolves.toMatchObject({ duplicate: false, ingested: false });
    await expect(duplicate.json()).resolves.toMatchObject({ duplicate: true, ingested: false });
  });
});
