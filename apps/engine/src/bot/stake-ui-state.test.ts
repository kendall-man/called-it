import { describe, expect, it, vi } from 'vitest';
import {
  STAKE_LADDER_TTL_MS,
  UiStateStore,
  type StakeUiState,
} from './stake-ui-state.js';

const MARKET = '0f14d0ab-9605-4a62-a9e4-5ed26688389b';
const USER = 8001;

/** A manual scheduler + clock so timers fire deterministically. */
function harness() {
  let nowMs = 1_000;
  const pending: Array<{ id: number; fn: () => void; dueMs: number }> = [];
  let nextId = 0;
  const expired: Array<{ marketId: string; userId: number; state: StakeUiState }> = [];
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
    onExpire: (marketId, userId, state) => expired.push({ marketId, userId, state }),
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

const state = (
  side: 'back' | 'doubt',
  code: 1 | 2 | 5 | 10,
  ephemeralMessageId = 5001,
): StakeUiState => ({ kind: 'ladder', side, code, ephemeralMessageId });

describe('UiStateStore', () => {
  it('stores and returns the current state before its TTL', () => {
    const { store } = harness();
    store.set(MARKET, USER, state('back', 1), STAKE_LADDER_TTL_MS);
    expect(store.get(MARKET, USER)).toEqual(state('back', 1));
  });

  it('keys by (market, user): a second member sizing the same market is independent', () => {
    const { store } = harness();
    store.set(MARKET, USER, state('back', 1, 111), STAKE_LADDER_TTL_MS);
    store.set(MARKET, 9002, state('doubt', 5, 222), STAKE_LADDER_TTL_MS);
    expect(store.get(MARKET, USER)).toEqual(state('back', 1, 111));
    expect(store.get(MARKET, 9002)).toEqual(state('doubt', 5, 222));
    // Clearing one member does not touch the other.
    store.clear(MARKET, USER);
    expect(store.get(MARKET, USER)).toBeNull();
    expect(store.get(MARKET, 9002)).toEqual(state('doubt', 5, 222));
  });

  it('fires onExpire exactly once when the TTL elapses (auto-revert)', () => {
    const { store, expired, advance } = harness();
    store.set(MARKET, USER, state('doubt', 2, 333), STAKE_LADDER_TTL_MS);
    advance(STAKE_LADDER_TTL_MS);
    expect(expired).toEqual([{ marketId: MARKET, userId: USER, state: state('doubt', 2, 333) }]);
    expect(store.get(MARKET, USER)).toBeNull();
  });

  it('lazily reverts an expired entry on read even if the timer never ran', () => {
    const { store, setNow } = harness();
    store.set(MARKET, USER, state('back', 1), STAKE_LADDER_TTL_MS);
    setNow(1_000 + STAKE_LADDER_TTL_MS + 1);
    expect(store.get(MARKET, USER)).toBeNull();
  });

  it('stepping to a new rung re-arms the timer so no stale revert fires', () => {
    const { store, expired, advance } = harness();
    store.set(MARKET, USER, state('back', 1), STAKE_LADDER_TTL_MS);
    // Step up 5s later; the fresh set() re-arms the auto-revert.
    advance(5_000);
    store.set(MARKET, USER, state('back', 5), STAKE_LADDER_TTL_MS);
    // The original timer (armed at t0) must not fire against the new rung.
    advance(STAKE_LADDER_TTL_MS - 5_000);
    expect(expired).toEqual([]);
    expect(store.get(MARKET, USER)).toEqual(state('back', 5));
    // The new rung's own TTL still fires from its set() time.
    advance(5_000);
    expect(expired).toEqual([
      { marketId: MARKET, userId: USER, state: state('back', 5) },
    ]);
  });

  it('clear removes the state and disarms its revert', () => {
    const { store, expired, advance } = harness();
    store.set(MARKET, USER, state('doubt', 2), STAKE_LADDER_TTL_MS);
    store.clear(MARKET, USER);
    expect(store.get(MARKET, USER)).toBeNull();
    advance(STAKE_LADDER_TTL_MS);
    expect(expired).toEqual([]);
  });

  it('stop cancels all pending reverts', () => {
    const { store, expired, advance } = harness();
    store.set(MARKET, USER, state('back', 1), STAKE_LADDER_TTL_MS);
    store.stop();
    advance(STAKE_LADDER_TTL_MS);
    expect(expired).toEqual([]);
  });

  it('defaults to real timers that do not keep the event loop alive', () => {
    vi.useFakeTimers();
    try {
      const store = new UiStateStore();
      store.set(MARKET, USER, state('back', 1), STAKE_LADDER_TTL_MS);
      expect(store.get(MARKET, USER, Date.now())).toEqual(state('back', 1));
      store.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
