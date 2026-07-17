import { describe, expect, it, vi } from 'vitest';
import {
  STAKE_LADDER_TTL_MS,
  STAKE_SIGN_TTL_MS,
  UiStateStore,
  type StakeUiState,
} from './stake-ui-state.js';

const MARKET = '0f14d0ab-9605-4a62-a9e4-5ed26688389b';

/** A manual scheduler + clock so timers fire deterministically. */
function harness() {
  let nowMs = 1_000;
  const pending: Array<{ id: number; fn: () => void; dueMs: number }> = [];
  let nextId = 0;
  const expired: Array<{ marketId: string; state: StakeUiState }> = [];
  const store = new UiStateStore({
    now: () => nowMs,
    schedule: (fn, ms) => {
      const id = (nextId += 1);
      pending.push({ id, fn, dueMs: nowMs + ms });
      return () => {
        const index = pending.findIndex((task) => task.id === id);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    onExpire: (marketId, state) => expired.push({ marketId, state }),
  });
  return {
    store,
    expired,
    advance(ms: number) {
      nowMs += ms;
      for (const task of [...pending].filter((t) => t.dueMs <= nowMs)) {
        const index = pending.indexOf(task);
        if (index >= 0) pending.splice(index, 1);
        task.fn();
      }
    },
    setNow(value: number) {
      nowMs = value;
    },
  };
}

describe('UiStateStore', () => {
  it('stores and returns the current state before its TTL', () => {
    const { store } = harness();
    store.set(MARKET, { kind: 'ladder', side: 'back' }, STAKE_LADDER_TTL_MS);
    expect(store.get(MARKET)).toEqual({ kind: 'ladder', side: 'back' });
  });

  it('fires onExpire exactly once when the TTL elapses (auto-revert)', () => {
    const { store, expired, advance } = harness();
    store.set(MARKET, { kind: 'ladder', side: 'doubt' }, STAKE_LADDER_TTL_MS);
    advance(STAKE_LADDER_TTL_MS);
    expect(expired).toEqual([{ marketId: MARKET, state: { kind: 'ladder', side: 'doubt' } }]);
    expect(store.get(MARKET)).toBeNull();
  });

  it('lazily reverts an expired entry on read even if the timer never ran', () => {
    const { store, setNow } = harness();
    store.set(MARKET, { kind: 'ladder', side: 'back' }, STAKE_LADDER_TTL_MS);
    setNow(1_000 + STAKE_LADDER_TTL_MS + 1);
    expect(store.get(MARKET)).toBeNull();
  });

  it('replacing a state cancels the old timer so no stale revert fires', () => {
    const { store, expired, advance } = harness();
    store.set(MARKET, { kind: 'ladder', side: 'back' }, STAKE_LADDER_TTL_MS);
    // Move to the sign step 5s later with a fresh, longer TTL.
    advance(5_000);
    store.set(MARKET, { kind: 'sign', side: 'back', amountCode: 5 }, STAKE_SIGN_TTL_MS);
    // The original 20s ladder timer must not fire against the new sign state.
    advance(STAKE_LADDER_TTL_MS);
    expect(expired).toEqual([]);
    expect(store.get(MARKET)).toEqual({ kind: 'sign', side: 'back', amountCode: 5 });
    // The sign TTL still fires from its own set() time.
    advance(STAKE_SIGN_TTL_MS);
    expect(expired).toEqual([
      { marketId: MARKET, state: { kind: 'sign', side: 'back', amountCode: 5 } },
    ]);
  });

  it('clear removes the state and disarms its revert', () => {
    const { store, expired, advance } = harness();
    store.set(MARKET, { kind: 'ladder', side: 'doubt' }, STAKE_LADDER_TTL_MS);
    store.clear(MARKET);
    expect(store.get(MARKET)).toBeNull();
    advance(STAKE_LADDER_TTL_MS);
    expect(expired).toEqual([]);
  });

  it('stop cancels all pending reverts', () => {
    const { store, expired, advance } = harness();
    store.set(MARKET, { kind: 'ladder', side: 'back' }, STAKE_LADDER_TTL_MS);
    store.stop();
    advance(STAKE_LADDER_TTL_MS);
    expect(expired).toEqual([]);
  });

  it('defaults to real timers that do not keep the event loop alive', () => {
    vi.useFakeTimers();
    try {
      const store = new UiStateStore();
      store.set(MARKET, { kind: 'ladder', side: 'back' }, STAKE_LADDER_TTL_MS);
      expect(store.get(MARKET, Date.now())).toEqual({ kind: 'ladder', side: 'back' });
      store.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
