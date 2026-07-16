import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Logger } from '../log.js';
import { DrainState } from './readiness.js';
import type {
  EscrowPositionAcceptApi,
  EscrowPositionAcceptInput,
} from './server.js';
import {
  CONCIERGE_TOKEN,
  ESCROW_WEB_TOKEN,
  MARKET_ID,
  closeActiveServer,
  startHarness,
} from './server-test-harness.js';

const TOKEN = 'c'.repeat(43);
const OWNER = '11111111111111111111111111111111';
const SIGNATURE = '2'.repeat(64);
const ESCROW_WEB_TOKEN_SHA256 = createHash('sha256').update(ESCROW_WEB_TOKEN).digest('hex');

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: TOKEN,
    telegramUserId: 42,
    privyUserId: 'did:privy:user-42',
    privyWalletId: 'wallet-42',
    ownerPubkey: OWNER,
    marketId: MARKET_ID,
    rawTransactionBase64: 'AQIDBA==',
    ...overrides,
  });
}

function api(
  accepted: EscrowPositionAcceptApi['accept'],
): EscrowPositionAcceptApi {
  return { accept: accepted };
}

function logger(entries: unknown[]): Logger {
  return {
    info: (event, fields) => entries.push({ event, fields }),
    warn: (event, fields) => entries.push({ event, fields }),
    error: (event, fields) => entries.push({ event, fields }),
    child: () => logger(entries),
  };
}

describe('POST /api/escrow/positions/accept', () => {
  afterEach(closeActiveServer);

  it('accepts only the dedicated web credential and forwards the strict identity body', async () => {
    const accepted: EscrowPositionAcceptInput[] = [];
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowPositions: api(async (input) => {
        accepted.push(input);
        return { kind: 'accepted', duplicate: false, jobCreated: true, signature: SIGNATURE };
      }),
    });
    const path = `${harness.base}/api/escrow/positions/accept`;

    const missing = await fetch(path, { method: 'POST', body: body() });
    const wrongScope = await fetch(path, {
      method: 'POST', headers: bearer(CONCIERGE_TOKEN), body: body(),
    });
    const response = await fetch(path, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: body(),
    });

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ kind: 'rejected', code: 'unauthorized' });
    expect(wrongScope.status).toBe(403);
    expect(await wrongScope.json()).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      kind: 'accepted', duplicate: false, jobCreated: true, signature: SIGNATURE,
    });
    expect(accepted).toEqual([{
      token: TOKEN,
      telegramUserId: 42,
      privyUserId: 'did:privy:user-42',
      privyWalletId: 'wallet-42',
      ownerPubkey: OWNER,
      marketId: MARKET_ID,
      rawTransactionBase64: 'AQIDBA==',
    }]);
  });

  it('rejects malformed, extra, credential-bearing, and tampered bodies without calling the port', async () => {
    let calls = 0;
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowPositions: api(async () => {
        calls += 1;
        return { kind: 'rejected', code: 'binding_mismatch' };
      }),
    });
    const path = `${harness.base}/api/escrow/positions/accept`;
    const headers = bearer(ESCROW_WEB_TOKEN);

    const malformed = await fetch(path, { method: 'POST', headers, body: '{' });
    const extra = await fetch(path, { method: 'POST', headers, body: body({ extra: true }) });
    const credential = await fetch(path, {
      method: 'POST', headers, body: body({ authorization: 'body-credential' }),
    });

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ kind: 'rejected', code: 'invalid_input' });
    expect(extra.status).toBe(400);
    expect(await extra.json()).toEqual({ kind: 'rejected', code: 'invalid_input' });
    expect(credential.status).toBe(401);
    expect(await credential.json()).toEqual({ kind: 'rejected', code: 'unauthorized' });
    expect(calls).toBe(0);
  });

  it('fails closed when only the accept port is wired without the web token digest', async () => {
    let calls = 0;
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowPositions: api(async () => {
        calls += 1;
        return { kind: 'accepted', duplicate: false, jobCreated: true, signature: SIGNATURE };
      }),
    });

    const response = await fetch(`${harness.base}/api/escrow/positions/accept`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: body(),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ kind: 'rejected', code: 'unauthorized' });
    expect(calls).toBe(0);
  });

  it('returns duplicate acceptance and stable service rejection schemas', async () => {
    const duplicateHarness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowPositions: api(async () => ({
        kind: 'accepted', duplicate: true, jobCreated: false, signature: SIGNATURE,
      })),
    });
    const duplicate = await fetch(`${duplicateHarness.base}/api/escrow/positions/accept`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: body(),
    });
    expect(await duplicate.json()).toEqual({
      kind: 'accepted', duplicate: true, jobCreated: false, signature: SIGNATURE,
    });
    await closeActiveServer();

    const rejectedHarness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      escrowPositions: api(async () => ({ kind: 'rejected', code: 'binding_mismatch' })),
    });
    const rejected = await fetch(`${rejectedHarness.base}/api/escrow/positions/accept`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: body(),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ kind: 'rejected', code: 'binding_mismatch' });
  });

  it('fails closed in legacy mode and during drain without calling the acceptor', async () => {
    let calls = 0;
    const acceptor = api(async () => {
      calls += 1;
      return { kind: 'accepted', duplicate: false, jobCreated: true, signature: SIGNATURE };
    });
    const legacy = await startHarness({
      escrowPositions: acceptor,
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
    });
    const legacyResponse = await fetch(`${legacy.base}/api/escrow/positions/accept`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: body(),
    });
    expect(legacyResponse.status).toBe(409);
    expect(await legacyResponse.json()).toEqual({ kind: 'rejected', code: 'unavailable_mode' });
    await closeActiveServer();

    const drainState = new DrainState();
    drainState.begin();
    const draining = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' }, drainState, escrowPositions: acceptor,
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
    });
    const drainResponse = await fetch(`${draining.base}/api/escrow/positions/accept`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: body(),
    });
    expect(drainResponse.status).toBe(503);
    expect(await drainResponse.json()).toEqual({ kind: 'rejected', code: 'draining' });
    expect(calls).toBe(0);
  });

  it('redacts thrown request data and returns a recoverable response', async () => {
    const entries: unknown[] = [];
    const secret = 'private-provider-and-session-material';
    const harness = await startHarness({
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      escrowWebTokenSha256: ESCROW_WEB_TOKEN_SHA256,
      log: logger(entries),
      escrowPositions: api(async () => {
        throw new Error(secret);
      }),
    });

    const response = await fetch(`${harness.base}/api/escrow/positions/accept`, {
      method: 'POST', headers: bearer(ESCROW_WEB_TOKEN), body: body({ privyUserId: secret }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      kind: 'rejected', code: 'temporarily_unavailable',
    });
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(entries)).not.toContain(TOKEN);
  });
});
