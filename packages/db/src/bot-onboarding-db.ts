import { createClient } from '@supabase/supabase-js';
import { DbError, type PgResult } from './errors.js';
import type {
  BotGroupReadyResult,
  BotOnboardingDb,
  BotOnboardingVersion,
} from './bot-onboarding-types.js';

export interface BotOnboardingDbClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<PgResult<unknown>>;
}

export function createBotOnboardingDb(url: string, serviceRoleKey: string): BotOnboardingDb {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return botOnboardingDbFromClient(client);
}

export function botOnboardingDbFromClient(candidate: unknown): BotOnboardingDb {
  const client = requireBotOnboardingDbClient(candidate);
  return {
    async markGroupReady(input) {
      assertSafeTelegramGroupId(input.groupId);
      const result = await client.rpc('bot_mark_group_ready', {
        p_group_id: input.groupId,
        p_onboarding_version: input.onboardingVersion,
      });
      if (result.error !== null || result.data === null) {
        throw new DbError('bot_mark_group_ready', result.error ?? { message: 'no RPC payload returned' });
      }
      return parseBotGroupReadyResult(result.data);
    },
  } satisfies BotOnboardingDb;
}

export function requireBotOnboardingDbClient(value: unknown): BotOnboardingDbClient {
  if (isBotOnboardingDbClient(value)) {
    return value;
  }
  throw new DbError('createBotOnboardingDb', { message: 'malformed Supabase client' });
}

function assertSafeTelegramGroupId(groupId: number): void {
  if (!Number.isSafeInteger(groupId)) {
    throw new DbError('bot_mark_group_ready', { message: 'group id must be a safe integer' });
  }
}

function parseBotGroupReadyResult(value: unknown): BotGroupReadyResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new DbError('bot_mark_group_ready', { message: 'malformed RPC payload' });
  }
  if (value.ok === false) {
    if (value.code === 'invalid_input' || value.code === 'group_not_found') {
      return { ok: false, code: value.code };
    }
    throw new DbError('bot_mark_group_ready', { message: 'unknown RPC error code' });
  }
  if (
    typeof value.created !== 'boolean' ||
    typeof value.group_id !== 'number' ||
    !Number.isSafeInteger(value.group_id) ||
    value.onboarding_version !== 'calledit_v1'
  ) {
    throw new DbError('bot_mark_group_ready', { message: 'malformed ready marker payload' });
  }
  return {
    ok: true,
    created: value.created,
    groupId: value.group_id,
    onboardingVersion: value.onboarding_version satisfies BotOnboardingVersion,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBotOnboardingDbClient(value: unknown): value is BotOnboardingDbClient {
  return typeof value === 'object' && value !== null && 'rpc' in value && typeof value.rpc === 'function';
}
