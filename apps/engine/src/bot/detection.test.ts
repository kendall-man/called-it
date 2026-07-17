/**
 * Tests for the stale-admin self-heal: a promotion that happened while the
 * engine was down never produced a my_chat_member update, so the passive
 * detection gate re-checks Telegram (throttled) and repairs groups.is_admin.
 */

import { describe, expect, it } from 'vitest';
import type { HandlerCtx } from './context.js';
import { probeAdminPromotion } from './detection.js';

function makeHarness(startMs = 1_000_000): {
  h: HandlerCtx;
  adminWrites: Array<{ chatId: number; isAdmin: boolean }>;
  advance: (ms: number) => void;
} {
  let nowMs = startMs;
  const adminWrites: Array<{ chatId: number; isAdmin: boolean }> = [];
  const h = {
    deps: {
      now: () => nowMs,
      db: {
        setGroupAdmin: async (chatId: number, isAdmin: boolean) => {
          adminWrites.push({ chatId, isAdmin });
        },
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    },
  } as unknown as HandlerCtx;
  return { h, adminWrites, advance: (ms) => (nowMs += ms) };
}

describe('probeAdminPromotion', () => {
  it('heals the group row when Telegram says the bot is now an administrator', async () => {
    const { h, adminWrites } = makeHarness();
    const promoted = await probeAdminPromotion(h, -101, async () => ({ status: 'administrator' }));
    expect(promoted).toBe(true);
    expect(adminWrites).toEqual([{ chatId: -101, isAdmin: true }]);
  });

  it('leaves the row alone while the bot is still a plain member', async () => {
    const { h, adminWrites } = makeHarness();
    const promoted = await probeAdminPromotion(h, -102, async () => ({ status: 'member' }));
    expect(promoted).toBe(false);
    expect(adminWrites).toEqual([]);
  });

  it('throttles probes per group so a chatty unpromoted group costs one API call a minute', async () => {
    const { h, advance } = makeHarness();
    let calls = 0;
    const member = async () => {
      calls += 1;
      return { status: 'member' };
    };
    await probeAdminPromotion(h, -103, member);
    advance(10_000);
    await probeAdminPromotion(h, -103, member);
    expect(calls).toBe(1);
    advance(60_000);
    await probeAdminPromotion(h, -103, member);
    expect(calls).toBe(2);
  });

  it('reports false without healing when the membership lookup itself fails', async () => {
    const { h, adminWrites } = makeHarness();
    const promoted = await probeAdminPromotion(h, -104, async () => {
      throw new Error('telegram unreachable');
    });
    expect(promoted).toBe(false);
    expect(adminWrites).toEqual([]);
  });
});
