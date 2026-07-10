import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_ID,
  USER_ID,
  authed,
  closeActiveServer,
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

  it('rejects Telegram forwarding when webhook ingress is not installed', async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.base}/api/telegram-ingress`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ update_id: 1, message: { text: 'hi' } }),
    });

    expect(response.status).toBe(403);
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
