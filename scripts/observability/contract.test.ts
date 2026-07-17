import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmacPseudonymizer, createTelemetryEvent } from './contract.js';

test('does not serialize secrets or PII when an event is built from untrusted input', () => {
  // Given
  const hmacSecret = 'ANALYTICS_HMAC_SECRET=telemetry-test-sentinel';
  const rawTelegramSource = 'msg:-1001234567890:42';
  const walletAddress = '9xQeWvG816bUx9EPfEZc2L6KpKXJ2H2QbYf7mPc3vAq';
  const signature = '5R2VvKq8XwYpZsG4JfG3M8Yq7D7gYF4M3D8S7K6L5P4Q';
  const initData = 'query_id=AAEAA&user=%7B%22first_name%22%3A%22Ada%22%7D';
  const event = createTelemetryEvent(
    {
      occurredAt: '2026-07-11T10:00:00.000Z',
      eventName: 'claim_detected',
      reasonCode: 'claim_detected',
      requestId: '6f526c43-4c56-4e24-b9a7-59b4b8e1d361',
      actorIdentifier: 'telegram:123456',
      groupIdentifier: 'telegram:-1001234567890',
      sourceIdentifier: rawTelegramSource,
      attemptCount: 1,
      durationMs: 24,
      metadata: {
        backlog_count: 3,
        nested: [walletAddress, { signature, initData, token: hmacSecret }],
      },
    },
    createHmacPseudonymizer(hmacSecret),
  );

  // When
  const serialized = JSON.stringify(event);

  // Then
  for (const forbiddenValue of [
    hmacSecret,
    rawTelegramSource,
    walletAddress,
    signature,
    initData,
    'telegram:123456',
    'telegram:-1001234567890',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbiddenValue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  }
  assert.deepEqual(event.metadata, { backlog_count: 3 });
  assert.match(event.actor_pseudonym ?? '', /^hmac_sha256:[a-f0-9]{64}$/u);
  assert.match(event.group_pseudonym ?? '', /^hmac_sha256:[a-f0-9]{64}$/u);
  assert.match(event.source_pseudonym ?? '', /^hmac_sha256:[a-f0-9]{64}$/u);
});
