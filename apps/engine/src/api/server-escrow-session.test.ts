import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Logger } from '../log.js';
import type {
  EscrowPlacementSessionInput,
  EscrowPlacementSessionResult,
  EscrowTelegramPort,
  EscrowWalletSessionResult,
} from '../bot/escrow-ux.js';
import { createEscrowSessionRateLimiter } from './server-escrow.js';
import {
  CONCIERGE_TOKEN,
  ESCROW_WEB_TOKEN,
  MARKET,
  MARKET_ID,
  closeActiveServer,
  startHarness,
} from './server-test-harness.js';

const ESCROW_WEB_TOKEN_SHA256 = createHash('sha256').update(ESCROW_WEB_TOKEN).digest('hex');
const SESSION_TOKEN = 'd'.repeat(43);
const EXPIRES_AT_ISO = '2026-07-08T12:05:00.000Z';
const IDEMPOTENCY_KEY = 'ab'.repeat(32);
const UNKNOWN_MARKET_ID = '99999999-8888-4777-8666-555555555555';

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function positionBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    marketId: MARKET_ID,
    side: 'back',
    amountPreset: 0,
    telegramUserId: 42,
    telegramUsername: 'caller_42',
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  });
}

function walletBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    telegramUserId: 42,
    telegramUsername: 'caller_42',
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  });
}

function sessionPort(overrides: {
  placement?: EscrowPlacementSessionResult;
  wallet?: EscrowWalletSessionResult;
} = {}): EscrowTelegramPort & {
  placementCalls: EscrowPlacementSessionInput[];
  walletCalls: Array<{ telegramUserId: number; idempotencyKey: string }>;
} {
  const placementCalls: EscrowPlacementSessionInput[] = [];
  const walletCalls: Array<{ telegramUserId: number; idempotencyKey: string }> = [];
  return {
    placementCalls,
    walletCalls,
    async createPlacementSession(input) {
      placementCalls.push(input);
      return overrides.placement
        ?? { kind: 'created', token: SESSION_TOKEN, expiresAt: EXPIRES_AT_ISO, duplicate: false };
    },
    async createWalletSession(input) {
      walletCalls.push(input);
      return overrides.wallet
        ?? { kind: 'created', token: SESSION_TOKEN, expiresAt: EXPIRES_AT_ISO };
    },
  };
}

function logger(entries: unknown[]): Logger {
  return {
    info: (event, fields) => entries.push({ event, fields }),
    warn: (event, fields) => entries.push({ event, fields }),
    error: (event, fields) => entries.push({ event, fields }),
    child: () => logger(entries),
  };
}

describe('POST /api/escrow/positions/session', () => {
  afterEach(closeActiveServer);

  it('accepts only the dedicated web credential', async () => {
    const port = sessionPort();
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
    });
    const path = `${harness.base}/api/escrow/positions/session`;

    const missing = await fetch(path, { method: 'POST', body: positionBody() });
    const wrongScope = await fetch(path, {
      method: 'POST', headers: bearer(CONCIERGE_TOKEN), body: positionBody(),
    });

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'unauthorized' });
    expect(wrongScope.status).toBe(403);
    expect(await wrongScope.json()).toEqual({ error: 'forbidden' });
    expect(port.placementCalls).toHaveLength(0);
  });

  it('mints a placement session through the same creator the DM flow uses', async () => {
    const port = sessionPort();
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
    });

    const response = await fetch(`${harness.base}/api/escrow/positions/session`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: positionBody({ side: 'against' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO });
    expect(port.placementCalls).toEqual([{
      idempotencyKey: IDEMPOTENCY_KEY,
      telegramUserId: 42,
      groupId: MARKET.group_id,
      marketId: MARKET_ID,
      side: 'doubt',
      asset: 'sol',
      amountAtomic: 10_000_000n,
      network: 'devnet',
      replay: false,
    }]);
  });

  it('maps the back side to the back placement input', async () => {
    const port = sessionPort();
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
    });

    const response = await fetch(`${harness.base}/api/escrow/positions/session`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: positionBody(),
    });

    expect(response.status).toBe(200);
    expect(port.placementCalls[0]?.side).toBe('back');
  });

  it('rejects malformed bodies without touching the creator', async () => {
    const port = sessionPort();
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
    });
    const path = `${harness.base}/api/escrow/positions/session`;
    const headers = bearer(ESCROW_WEB_TOKEN);
    const invalidBodies = [
      '{',
      positionBody({ side: 'up' }),
      positionBody({ amountPreset: 1 }),
      positionBody({ marketId: 'not-a-uuid' }),
      positionBody({ idempotencyKey: 'short' }),
      positionBody({ telegramUserId: -1 }),
      positionBody({ extra: true }),
    ];

    for (const body of invalidBodies) {
      const response = await fetch(path, { method: 'POST', headers, body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    }
    expect(port.placementCalls).toHaveLength(0);
  });

  it('returns market_not_found for unknown markets', async () => {
    const port = sessionPort();
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
    });

    const response = await fetch(`${harness.base}/api/escrow/positions/session`, {
      method: 'POST',
      headers: bearer(ESCROW_WEB_TOKEN),
      body: positionBody({ marketId: UNKNOWN_MARKET_ID }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'market_not_found' });
    expect(port.placementCalls).toHaveLength(0);
  });

  it('returns market_closed for markets no longer accepting positions', async () => {
    const port = sessionPort();
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
      market: { ...MARKET, status: 'settled' },
    });

    const response = await fetch(`${harness.base}/api/escrow/positions/session`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: positionBody(),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'market_closed' });
    expect(port.placementCalls).toHaveLength(0);
  });

  it('maps creator rejections onto the shared error contract', async () => {
    const cases = [
      { placement: { kind: 'rejected', code: 'wallet_required' }, status: 409, error: 'wallet_required' },
      { placement: { kind: 'rejected', code: 'market_closed' }, status: 409, error: 'market_closed' },
      { placement: { kind: 'rejected', code: 'paused' }, status: 409, error: 'positions_paused' },
      { placement: { kind: 'rejected', code: 'amount_out_of_range' }, status: 400, error: 'invalid_request' },
      { placement: { kind: 'rejected', code: 'temporarily_unavailable' }, status: 503, error: 'temporarily_unavailable' },
      { placement: { kind: 'rejected', code: 'callback_expired' }, status: 503, error: 'temporarily_unavailable' },
    ] as const;

    for (const testCase of cases) {
      const harness = await startHarness({
        env: { WAGER_CUSTODY_MODE: 'escrow' },
        escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
        escrowSessions: sessionPort({ placement: testCase.placement }),
      });

      const response = await fetch(`${harness.base}/api/escrow/positions/session`, {
        method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: positionBody(),
      });

      expect(response.status).toBe(testCase.status);
      expect(await response.json()).toEqual({ error: testCase.error });
      await closeActiveServer();
    }
  });

  it('rate limits to six session creates per user per minute', async () => {
    const port = sessionPort();
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
    });
    const path = `${harness.base}/api/escrow/positions/session`;
    const headers = bearer(ESCROW_WEB_TOKEN);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const allowed = await fetch(path, { method: 'POST', headers, body: positionBody() });
      expect(allowed.status).toBe(200);
    }
    const limited = await fetch(path, { method: 'POST', headers, body: positionBody() });
    const otherUser = await fetch(path, {
      method: 'POST', headers, body: positionBody({ telegramUserId: 77 }),
    });

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect(otherUser.status).toBe(200);
    expect(port.placementCalls).toHaveLength(7);
  });

  it('fails closed outside escrow custody and when the session port is unwired', async () => {
    const port = sessionPort();
    const legacy = await startHarness({
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
    });
    const legacyResponse = await fetch(`${legacy.base}/api/escrow/positions/session`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: positionBody(),
    });
    expect(legacyResponse.status).toBe(503);
    expect(await legacyResponse.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(port.placementCalls).toHaveLength(0);
    await closeActiveServer();

    const unwired = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
    });
    const unwiredResponse = await fetch(`${unwired.base}/api/escrow/positions/session`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: positionBody(),
    });
    expect(unwiredResponse.status).toBe(503);
    expect(await unwiredResponse.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it('never logs the minted session token', async () => {
    const entries: unknown[] = [];
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: sessionPort(),
      log: logger(entries),
    });

    const response = await fetch(`${harness.base}/api/escrow/positions/session`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: positionBody(),
    });

    expect(response.status).toBe(200);
    expect(JSON.stringify(entries)).not.toContain(SESSION_TOKEN);
  });
});

describe('POST /api/escrow/wallet/session', () => {
  afterEach(closeActiveServer);

  it('accepts only the dedicated web credential', async () => {
    const port = sessionPort();
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
    });
    const path = `${harness.base}/api/escrow/wallet/session`;

    const missing = await fetch(path, { method: 'POST', body: walletBody() });
    const wrongScope = await fetch(path, {
      method: 'POST', headers: bearer(CONCIERGE_TOKEN), body: walletBody(),
    });

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'unauthorized' });
    expect(wrongScope.status).toBe(403);
    expect(await wrongScope.json()).toEqual({ error: 'forbidden' });
    expect(port.walletCalls).toHaveLength(0);
  });

  it('mints a wallet-link session exactly like the /wallet DM flow', async () => {
    const port = sessionPort();
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
    });

    const response = await fetch(`${harness.base}/api/escrow/wallet/session`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: walletBody(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: SESSION_TOKEN, expiresAtIso: EXPIRES_AT_ISO });
    expect(port.walletCalls).toEqual([{ telegramUserId: 42, idempotencyKey: IDEMPOTENCY_KEY }]);
  });

  it('rejects malformed bodies without touching the creator', async () => {
    const port = sessionPort();
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
    });
    const path = `${harness.base}/api/escrow/wallet/session`;
    const headers = bearer(ESCROW_WEB_TOKEN);
    const invalidBodies = [
      '{',
      walletBody({ telegramUserId: 'not-a-number' }),
      walletBody({ idempotencyKey: 'short' }),
      walletBody({ extra: true }),
    ];

    for (const body of invalidBodies) {
      const response = await fetch(path, { method: 'POST', headers, body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    }
    expect(port.walletCalls).toHaveLength(0);
  });

  it('rate limits to six wallet session creates per user per minute', async () => {
    const port = sessionPort();
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: port,
    });
    const path = `${harness.base}/api/escrow/wallet/session`;
    const headers = bearer(ESCROW_WEB_TOKEN);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const allowed = await fetch(path, { method: 'POST', headers, body: walletBody() });
      expect(allowed.status).toBe(200);
    }
    const limited = await fetch(path, { method: 'POST', headers, body: walletBody() });

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect(port.walletCalls).toHaveLength(6);
  });

  it('returns a retryable failure when the wallet session creator rejects', async () => {
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: sessionPort({
        wallet: { kind: 'rejected', code: 'temporarily_unavailable' },
      }),
    });

    const response = await fetch(`${harness.base}/api/escrow/wallet/session`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: walletBody(),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it('never logs the minted wallet token', async () => {
    const entries: unknown[] = [];
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowSessions: sessionPort(),
      log: logger(entries),
    });

    const response = await fetch(`${harness.base}/api/escrow/wallet/session`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: walletBody(),
    });

    expect(response.status).toBe(200);
    expect(JSON.stringify(entries)).not.toContain(SESSION_TOKEN);
  });
});

describe('createEscrowSessionRateLimiter', () => {
  it('allows again once the sliding minute window passes', () => {
    let nowMs = 0;
    const limiter = createEscrowSessionRateLimiter(() => nowMs);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(limiter.allow(1)).toBe(true);
    }
    expect(limiter.allow(1)).toBe(false);
    expect(limiter.allow(2)).toBe(true);

    nowMs = 60_001;
    expect(limiter.allow(1)).toBe(true);
  });
});
