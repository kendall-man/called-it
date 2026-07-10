import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_ID,
  MARKET,
  MARKET_ID,
  USER_ID,
  authed,
  closeActiveServer,
  stakeBody,
  startHarness,
} from './server-test-harness.js';

afterEach(closeActiveServer);

describe('engine application API', () => {
  it('serves the group snapshot with SOL markets and pots', async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.base}/api/groups/${CHAT_ID}/snapshot`, {
      headers: authed,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      markets: [{ currency: 'sol', matchedPct: 0, forSol: '0' }],
    });
    expect(body).not.toHaveProperty('leaderboard');
  });

  it('returns the wallet as a SOL stack with the linked pubkey', async () => {
    const harness = await startHarness();
    const response = await fetch(
      `${harness.base}/api/groups/${CHAT_ID}/users/${USER_ID}/wallet`,
      { headers: authed },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      linkedWallet: 'Wa11etPubkey1111111111111111111111111111',
      balanceLamports: '1000000000',
      balanceSol: '1',
    });
  });

  it('places a SOL bet over HTTP and escrows it in the wager ledger', async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.base}/api/stake`, {
      method: 'POST', headers: authed, body: stakeBody(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ placed: true });
    expect(harness.wagerDb.positions).toHaveLength(1);
    expect(harness.wagerDb.positions[0]).toMatchObject({
      stake: 50_000_000, side: 'back', user_id: USER_ID,
    });
    expect(harness.wagerDb.ledger.find((entry) => entry.kind === 'stake')?.lamports)
      .toBe(-50_000_000n);
  });

  it('does not double-stake when Eve replays an idempotency key', async () => {
    const harness = await startHarness();
    const body = stakeBody({ idempotencyKey: 'call-dup-1' });
    const first = await fetch(`${harness.base}/api/stake`, {
      method: 'POST', headers: authed, body,
    });
    const second = await fetch(`${harness.base}/api/stake`, {
      method: 'POST', headers: authed, body,
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ placed: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ placed: false });
    expect(harness.wagerDb.positions).toHaveLength(1);
  });

  it('rejects negative, zero, and over-cap amounts at the schema', async () => {
    const harness = await startHarness();
    for (const amount of [-0.05, 0, 0.5]) {
      const response = await fetch(`${harness.base}/api/stake`, {
        method: 'POST',
        headers: authed,
        body: stakeBody({ amount, idempotencyKey: `call-bad-${amount}` }),
      });
      expect(response.status).toBe(400);
    }
    expect(harness.wagerDb.positions).toHaveLength(0);
  });

  it('relays an insufficient-balance refusal without placing a position', async () => {
    const harness = await startHarness({ balanceLamports: 1_000_000n });
    const response = await fetch(`${harness.base}/api/stake`, {
      method: 'POST',
      headers: authed,
      body: stakeBody({ idempotencyKey: 'call-poor-1' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ placed: false });
    expect(harness.wagerDb.positions).toHaveLength(0);
  });

  it('returns 404 for an unknown market and 409 for a closed market', async () => {
    const harness = await startHarness({ market: { ...MARKET, status: 'settled' } });
    const unknown = await fetch(`${harness.base}/api/stake`, {
      method: 'POST',
      headers: authed,
      body: stakeBody({
        marketId: '99999999-2222-4333-8444-555555555555',
        idempotencyKey: 'call-unk-1',
      }),
    });
    const closed = await fetch(`${harness.base}/api/stake`, {
      method: 'POST', headers: authed,
      body: stakeBody({ idempotencyKey: 'call-closed-1' }),
    });

    expect(unknown.status).toBe(404);
    expect(closed.status).toBe(409);
  });

  it('rejects Telegram forwarding when webhook ingress is not installed', async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.base}/api/telegram-update`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ update_id: 1, message: { text: 'hi' } }),
    });

    expect(response.status).toBe(409);
  });

  it('quotes a claim read-only', async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.base}/api/quote`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ chatId: CHAT_ID, text: 'Spain win this easy' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'ok',
      options: [{ quote: { kind: 'ok', backMultiplier: 2 } }],
    });
    expect(harness.wagerDb.positions).toHaveLength(0);
  });
});
