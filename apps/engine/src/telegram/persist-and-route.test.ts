import { describe, expect, it } from 'vitest';
import { TEST_ENV } from '../api/server-test-env.js';
import type { TelegramPersistPort, TelegramValidatedUpdate } from './ports.js';
import { createPersistAndRoute } from './persist-and-route.js';

describe('createPersistAndRoute', () => {
  it('persists the derived identity, fresh routing decision, and original payload', async () => {
    const calls: Array<Parameters<TelegramPersistPort['persistUpdate']>[0]> = [];
    const db: TelegramPersistPort = {
      persistUpdate: async (input) => {
        calls.push(input);
        return {
          id: '00000000-0000-4000-8000-000000000001',
          routingDecision: input.routingDecision,
          state: input.routingDecision,
          duplicate: false,
        };
      },
    };
    const persistAndRoute = createPersistAndRoute({
      analyticsHmacSecretBase64: TEST_ENV.ANALYTICS_HMAC_SECRET,
      db,
      route: async () => 'pending_engine',
    });
    const update: TelegramValidatedUpdate = {
      update_id: 61,
      message: {
        message_id: 16,
        chat: { id: -1001, type: 'supergroup' },
        text: 'France win today',
      },
    };

    await expect(persistAndRoute(update)).resolves.toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      routingDecision: 'pending_engine',
      state: 'pending_engine',
      duplicate: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sourceKey: 'msg:-1001:16',
      telegramUpdateId: 61,
      updateType: 'message',
      payload: update,
      routingDecision: 'pending_engine',
    });
  });

  it('returns the original committed routing decision on duplicates', async () => {
    const persistAndRoute = createPersistAndRoute({
      analyticsHmacSecretBase64: TEST_ENV.ANALYTICS_HMAC_SECRET,
      db: {
        persistUpdate: async () => ({
          id: '00000000-0000-4000-8000-000000000002',
          routingDecision: 'routed_concierge',
          state: 'routed_concierge',
          duplicate: true,
        }),
      },
      route: async () => 'pending_engine',
    });

    await expect(
      persistAndRoute({
        update_id: 62,
        message: {
          message_id: 17,
          chat: { id: 10, type: 'private' },
          text: '/bookit',
        },
      }),
    ).resolves.toMatchObject({
      routingDecision: 'routed_concierge',
      state: 'routed_concierge',
      duplicate: true,
    });
  });
});
