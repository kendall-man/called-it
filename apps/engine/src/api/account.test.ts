import { afterEach, describe, expect, it } from 'vitest';
import {
  CONCIERGE_TOKEN,
  CHAT_ID,
  MARKET,
  MARKET_ID,
  NOW,
  TELEGRAM_TOKEN,
  USER_ID,
  closeActiveServer,
  startHarness,
} from './server-test-harness.js';

type Wallet = {
  readonly pubkey: string;
  readonly signMessage: (message: string) => string;
};

type ChallengeResponse = {
  readonly challengeId: string;
  readonly message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected JSON object');
  }
  return value;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string') throw new Error(`missing ${field}`);
  return candidate;
}

function challengeResponse(value: unknown): ChallengeResponse {
  const body = record(value);
  return {
    challengeId: stringField(body, 'challengeId'),
    message: stringField(body, 'message'),
  };
}

function intentId(value: unknown): string {
  const intent = record(record(value)['intent']);
  return stringField(intent, 'intentId');
}

function createWallet(): Wallet {
  return {
    pubkey: '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj',
    signMessage: () => 'test-signature',
  };
}

function authHeaders(): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${CONCIERGE_TOKEN}`,
    'content-type': 'application/json',
  };
}

function jsonBody(body: unknown): string {
  return JSON.stringify(body);
}

function groupPrincipal(userId = USER_ID): { readonly userId: number; readonly groupId: number } {
  return { userId, groupId: CHAT_ID };
}

async function createIntent(base: string, correlationId: string): Promise<Response> {
  return await fetch(`${base}/api/account/stake-intents`, {
    method: 'POST',
    headers: authHeaders(),
    body: jsonBody({
      principal: groupPrincipal(),
      marketId: MARKET_ID,
      side: 'back',
      lamports: '50000000',
      correlationId,
    }),
  });
}

afterEach(closeActiveServer);

describe('wallet challenge API', () => {
  it('creates a one-time challenge, verifies it once, and rejects replay', async () => {
    // Given an authenticated concierge principal and a wallet-link signer seam
    const harness = await startHarness({ link: false });
    const wallet = createWallet();

    // When the principal creates and verifies a wallet challenge
    const created = await fetch(`${harness.base}/api/account/challenges`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ principal: { userId: USER_ID }, pubkey: wallet.pubkey }),
    });
    expect(created.status).toBe(201);
    const challenge = challengeResponse(await created.json());
    const verificationBody = JSON.stringify({
      principal: { userId: USER_ID },
      challengeId: challenge.challengeId,
      pubkey: wallet.pubkey,
      signature: wallet.signMessage(challenge.message),
    });
    const verified = await fetch(`${harness.base}/api/account/challenges/verify`, {
      method: 'POST',
      headers: authHeaders(),
      body: verificationBody,
    });
    const replayed = await fetch(`${harness.base}/api/account/challenges/verify`, {
      method: 'POST',
      headers: authHeaders(),
      body: verificationBody,
    });

    // Then the wallet is linked exactly once and replay has a stable refusal
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ wallet: { status: 'verified' } });
    expect(replayed.status).toBe(409);
    expect(await replayed.json()).toEqual({ error: 'challenge_invalid' });
  });
});

describe('pending stake intent API', () => {
  it('preserves one bound intent through funding and consumes it only after final confirmation', async () => {
    // Given a concierge principal with a live SOL market
    const harness = await startHarness();

    // When funding is observed before the user explicitly confirms the preserved intent
    const created = await createIntent(harness.base, 'telegram:callback:one');
    const createdIntentId = intentId(await created.json());
    const conflicting = await createIntent(harness.base, 'telegram:callback:different');
    const funded = await fetch(`${harness.base}/api/account/stake-intents/${createdIntentId}/funding-observed`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({ principal: groupPrincipal() }),
    });
    const withoutConfirmation = await fetch(`${harness.base}/api/account/stake-intents/${createdIntentId}/confirm`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({ principal: groupPrincipal() }),
    });
    const confirmed = await fetch(`${harness.base}/api/account/stake-intents/${createdIntentId}/confirm`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({ principal: groupPrincipal(), finalConfirmation: true }),
    });
    const replayed = await fetch(`${harness.base}/api/account/stake-intents/${createdIntentId}/confirm`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({ principal: groupPrincipal(), finalConfirmation: true }),
    });

    // Then only the explicit confirmation consumes it, without placing a position yet
    expect(created.status).toBe(201);
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toEqual({ error: 'active_intent_exists' });
    expect(funded.status).toBe(200);
    expect(withoutConfirmation.status).toBe(409);
    expect(await withoutConfirmation.json()).toEqual({ error: 'final_confirmation_required' });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ intent: { intentId: createdIntentId, state: 'consumed' } });
    expect(replayed.status).toBe(409);
    expect(await replayed.json()).toEqual({ error: 'intent_not_ready' });
    expect(harness.wagerDb.positions).toHaveLength(0);
  });

  it('rejects expired, swapped, foreign, and closed-market requests without leaking or mutating state', async () => {
    // Given a challenge and intent whose principal, wallet, and market bindings are fixed
    let now = NOW;
    const harness = await startHarness({ now: () => now });
    const wallet = createWallet();
    const challenge = await fetch(`${harness.base}/api/account/challenges`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({ principal: { userId: USER_ID }, pubkey: wallet.pubkey }),
    });
    const challengeBody = challengeResponse(await challenge.json());
    now += 5 * 60_000;
    const expired = await fetch(`${harness.base}/api/account/challenges/verify`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({
        principal: { userId: USER_ID },
        challengeId: challengeBody.challengeId,
        pubkey: wallet.pubkey,
        signature: wallet.signMessage(challengeBody.message),
      }),
    });
    const created = await createIntent(harness.base, 'telegram:callback:two');
    const createdIntentId = intentId(await created.json());
    const foreign = await fetch(`${harness.base}/api/account/stake-intents/${createdIntentId}/cancel`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({ principal: groupPrincipal(USER_ID + 1) }),
    });
    const swappedChallenge = await fetch(`${harness.base}/api/account/challenges`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({ principal: { userId: USER_ID }, pubkey: wallet.pubkey }),
    });
    const swappedChallengeBody = challengeResponse(await swappedChallenge.json());
    const swapped = await fetch(`${harness.base}/api/account/challenges/verify`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({
        principal: { userId: USER_ID },
        challengeId: swappedChallengeBody.challengeId,
        pubkey: `${wallet.pubkey.slice(0, -1)}2`,
        signature: 'not-used-after-wallet-swap',
      }),
    });
    now += 10 * 60_000;
    const expiredIntent = await fetch(`${harness.base}/api/account/stake-intents/${createdIntentId}/cancel`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({ principal: groupPrincipal() }),
    });

    // Then every rejection has a stable code and no stale or foreign mutation succeeds
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: 'challenge_expired' });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'intent_not_found' });
    expect(swapped.status).toBe(403);
    expect(await swapped.json()).toEqual({ error: 'principal_mismatch' });
    expect(expiredIntent.status).toBe(410);
    expect(await expiredIntent.json()).toEqual({ error: 'intent_expired' });
    expect(harness.wagerDb.pendingStakeIntents.get(createdIntentId)?.state).toBe('pending');
  });

  it('rejects a closed market before it creates an intent', async () => {
    // Given a principal requests an intent for a terminal market
    const harness = await startHarness({ market: { ...MARKET, status: 'settled' } });

    // When the account route validates the bound market
    const response = await createIntent(harness.base, 'telegram:callback:closed');

    // Then no active intent is created
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'market_closed' });
    expect(harness.wagerDb.pendingStakeIntents.size).toBe(0);
  });

  it('keeps account and intent responses free of secret-bearing fields', async () => {
    // Given an authenticated account and a pending intent
    const harness = await startHarness();
    const created = await createIntent(harness.base, 'telegram:callback:redaction');
    const state = await fetch(`${harness.base}/api/account/state`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({ principal: { userId: USER_ID } }),
    });
    const active = await fetch(`${harness.base}/api/account/stake-intents/active`, {
      method: 'POST',
      headers: authHeaders(),
      body: jsonBody({ principal: groupPrincipal() }),
    });

    // When their public JSON is serialized
    const serialized = [await created.text(), await state.text(), await active.text()].join('\n');

    // Then it exposes neither bearer material nor identity details unnecessary to the account state
    expect(serialized).not.toContain(CONCIERGE_TOKEN);
    expect(serialized).not.toContain('challenge_hash');
    expect(serialized).not.toContain('intent_key');
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('Dee Real Name');
  });

  it('limits requests by the validated principal and keeps account routes concierge-scoped', async () => {
    // Given a valid principal exceeding the challenge creation budget and a Telegram-scoped caller
    const harness = await startHarness();
    const wallet = createWallet();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () => fetch(`${harness.base}/api/account/challenges`, {
        method: 'POST',
        headers: authHeaders(),
        body: jsonBody({ principal: { userId: USER_ID }, pubkey: wallet.pubkey }),
      })),
    );
    const wrongScope = await fetch(`${harness.base}/api/account/state`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TELEGRAM_TOKEN}`,
        'content-type': 'application/json',
      },
      body: jsonBody({ principal: { userId: USER_ID } }),
    });

    // When the route processes those authenticated requests

    // Then the sixth request is limited and the Telegram token cannot access account state
    expect(attempts.map((response) => response.status)).toEqual([201, 201, 201, 201, 201, 429]);
    const limited = attempts[5];
    if (limited === undefined) throw new Error('expected sixth rate-limit attempt');
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect(wrongScope.status).toBe(403);
    expect(await wrongScope.json()).toEqual({ error: 'forbidden' });
  });
});
