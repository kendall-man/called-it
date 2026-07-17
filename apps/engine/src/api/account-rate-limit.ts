import type { AccountPrincipal, GroupPrincipal } from './account-protocol.js';

type RateLimitOperation = 'challenge' | 'verification' | 'intent_read' | 'intent_write';

type Limit = {
  readonly max: number;
  readonly windowMs: number;
};

const LIMITS: Readonly<Record<RateLimitOperation, Limit>> = {
  challenge: { max: 5, windowMs: 60_000 },
  verification: { max: 10, windowMs: 60_000 },
  intent_read: { max: 30, windowMs: 60_000 },
  intent_write: { max: 12, windowMs: 60_000 },
};

const MAX_TRACKED_KEYS = 10_000;

export interface AccountRateLimiter {
  allow(input: {
    readonly operation: RateLimitOperation;
    readonly principal: AccountPrincipal | GroupPrincipal;
  }): boolean;
}

export function createAccountRateLimiter(now: () => number): AccountRateLimiter {
  const attempts = new Map<string, number[]>();
  return {
    allow({ operation, principal }) {
      const limit = LIMITS[operation];
      const key = `${operation}:${principal.userId}:${'groupId' in principal ? principal.groupId : '-'}`;
      const current = now();
      const prior = attempts.get(key)?.filter((attempt) => attempt > current - limit.windowMs) ?? [];
      if (prior.length >= limit.max) {
        attempts.set(key, prior);
        return false;
      }
      if (attempts.size >= MAX_TRACKED_KEYS && !attempts.has(key)) return false;
      prior.push(current);
      attempts.set(key, prior);
      return true;
    },
  };
}
