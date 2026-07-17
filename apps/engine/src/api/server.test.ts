import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_ID,
  MARKET,
  MARKET_ID,
  OPS_TOKEN,
  PRIVATE_DISPLAY_NAME,
  PRIVATE_USERNAME,
  TELEGRAM_TOKEN,
  USER_ID,
  authed,
  closeActiveServer,
  startHarness,
} from './server-test-harness.js';

type PrivacyReadRoute = {
  readonly label: string;
  readonly path: string;
  readonly expectedStatus: number;
  readonly init?: RequestInit;
};

const PRIVACY_READ_ROUTES: readonly PrivacyReadRoute[] = [
  { label: 'legacy health', path: '/api/health', expectedStatus: 404 },
  { label: 'liveness', path: '/api/live', expectedStatus: 200 },
  { label: 'readiness', path: '/api/ready', expectedStatus: 200 },
  {
    label: 'fixture list',
    path: '/api/fixtures',
    expectedStatus: 200,
    init: { headers: authed },
  },
  {
    label: 'market summary',
    path: `/api/markets/${MARKET_ID}`,
    expectedStatus: 200,
    init: { headers: authed },
  },
  {
    label: 'operations status',
    path: '/api/ops/status',
    expectedStatus: 200,
    init: { headers: { authorization: `Bearer ${OPS_TOKEN}` } },
  },
];

const PRIVATE_API_FIELDS = new Set([
  'accuracy',
  'bestStreak',
  'best_streak',
  'currentStreak',
  'current_streak',
  'displayName',
  'display_name',
  'leaderboard',
  'losses',
  'participant',
  'participants',
  'points',
  'pointsCached',
  'pointsDelta',
  'points_cached',
  'points_delta',
  'rank',
  'scoredCount',
  'scored_count',
  'userId',
  'user_id',
  'username',
  'winnerCount',
  'winner_count',
  'wins',
]);

function assertPrivateApiBoundary(body: unknown): void {
  const pending = [body];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      expect(value).not.toContain(PRIVATE_DISPLAY_NAME);
      expect(value).not.toContain(PRIVATE_USERNAME);
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    for (const [key, nested] of Object.entries(value)) {
      expect(PRIVATE_API_FIELDS.has(key), `private API field: ${key}`).toBe(false);
      pending.push(nested);
    }
  }
}

afterEach(closeActiveServer);

describe('engine application API', () => {
  it('rejects nested point data at the API privacy boundary', () => {
    const malformedOutput = { ok: true, result: { points: 10 } };

    expect(() => assertPrivateApiBoundary(malformedOutput)).toThrow();
  });

  it('rejects renamed participant identity in successful API output', () => {
    const misleadingOutput = { ok: true, result: { label: PRIVATE_DISPLAY_NAME } };

    expect(() => assertPrivateApiBoundary(misleadingOutput)).toThrow();
  });

  it.each(PRIVACY_READ_ROUTES)(
    'keeps $label output outside the points and participant boundary',
    async ({ path, expectedStatus, init }) => {
      const harness = await startHarness();

      const response = await fetch(`${harness.base}${path}`, init);

      expect(response.status).toBe(expectedStatus);
      assertPrivateApiBoundary(await response.json());
    },
  );

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
    assertPrivateApiBoundary(body);
  });

  it('serves USDC markets with asset-aware atomic and display amounts', async () => {
    const harness = await startHarness({ market: { ...MARKET, currency: 'usdc' } });
    const response = await fetch(`${harness.base}/api/groups/${CHAT_ID}/snapshot`, {
      headers: authed,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      markets: [{
        currency: 'usdc',
        forAtomic: '0',
        forAmount: '0',
      }],
    });
    expect(body).toMatchObject({
      markets: [expect.not.objectContaining({ forSol: expect.anything() })],
    });
    assertPrivateApiBoundary(body);
  });

  it('returns both asset balances with legacy SOL aliases', async () => {
    const harness = await startHarness({ balanceUsdcAtomic: 2_500_000n });
    const response = await fetch(
      `${harness.base}/api/groups/${CHAT_ID}/users/${USER_ID}/wallet`,
      { headers: authed },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      linkedWallet: 'Wa11etPubkey1111111111111111111111111111',
      balanceLamports: '1000000000',
      balanceSol: '1',
      balances: {
        sol: { availableAtomic: '1000000000', availableAmount: '1' },
        usdc: { availableAtomic: '2500000', availableAmount: '2.5' },
      },
    });
    assertPrivateApiBoundary(body);
  });

  it('does not expose a raw wallet-linking mutation route', async () => {
    const harness = await startHarness();
    const response = await fetch(
      `${harness.base}/api/groups/${CHAT_ID}/users/${USER_ID}/wallet`,
      {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ pubkey: 'RawWalletPubkey111111111111111111111111111' }),
      },
    );

    expect(response.status).toBe(404);
    assertPrivateApiBoundary(await response.json());
  });

  it('rejects Telegram forwarding when webhook ingress is not installed', async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.base}/api/telegram-ingress`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ update_id: 1, message: { text: 'hi' } }),
    });

    expect(response.status).toBe(403);
    assertPrivateApiBoundary(await response.json());
  });

  it('keeps successful Telegram ingress output outside the private points boundary', async () => {
    const harness = await startHarness({ handleTelegramUpdate: async () => undefined });
    const response = await fetch(`${harness.base}/api/telegram-ingress`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TELEGRAM_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ update_id: 1, message: { text: 'hi' } }),
    });

    expect(response.status).toBe(200);
    assertPrivateApiBoundary(await response.json());
  });

  it('quotes a claim read-only', async () => {
    const harness = await startHarness();
    const response = await fetch(`${harness.base}/api/quote`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ chatId: CHAT_ID, text: 'Spain win this easy' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      kind: 'ok',
      options: [{ quote: { kind: 'ok', backMultiplier: 2 } }],
    });
    assertPrivateApiBoundary(body);
    expect(harness.wagerDb.positions).toHaveLength(0);
  });
});
