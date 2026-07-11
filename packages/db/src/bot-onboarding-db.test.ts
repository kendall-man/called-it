import { describe, expect, it } from 'vitest';
import {
  botOnboardingDbFromClient,
  type BotOnboardingDbClient,
} from './bot-onboarding-db.js';

describe('bot onboarding DB facade', () => {
  it('returns the database-owned first-ready decision without retrying it in application code', async () => {
    // Given a service client whose ready-marker RPC reports a duplicate group start
    const calls: Array<{ readonly fn: string; readonly args: Record<string, unknown> }> = [];
    const client = {
      async rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        return {
          data: {
            ok: true,
            created: false,
            group_id: -100123,
            onboarding_version: 'calledit_v1',
          },
          error: null,
        };
      },
    } satisfies BotOnboardingDbClient;
    const db = botOnboardingDbFromClient(client);

    // When the same group/version is claimed again
    const result = await db.markGroupReady({ groupId: -100123, onboardingVersion: 'calledit_v1' });

    // Then the facade preserves the duplicate decision from the database
    expect(result).toEqual({
      ok: true,
      created: false,
      groupId: -100123,
      onboardingVersion: 'calledit_v1',
    });
    expect(calls).toEqual([
      {
        fn: 'bot_mark_group_ready',
        args: { p_group_id: -100123, p_onboarding_version: 'calledit_v1' },
      },
    ]);
  });
});
