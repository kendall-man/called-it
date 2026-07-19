import { describe, expect, it } from 'vitest';
import { SendQueue } from './sendQueue.js';

/** Virtual clock: sleep() advances time instantly; schedule() fires manually. */
function makeVirtualClock() {
  let nowMs = 0;
  const scheduled: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    now: () => nowMs,
    sleep: (ms: number) => {
      nowMs += ms;
      fireDue();
      return Promise.resolve();
    },
    schedule: (fn: () => void, ms: number) => {
      const entry = { at: nowMs + ms, fn, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    advance(ms: number) {
      nowMs += ms;
      fireDue();
    },
  };
  function fireDue() {
    for (const entry of scheduled) {
      if (!entry.cancelled && entry.at <= nowMs) {
        entry.cancelled = true;
        entry.fn();
      }
    }
  }
}

describe('SendQueue', () => {
  it('spaces sends so a burst never exceeds the per-minute rate', async () => {
    const clock = makeVirtualClock();
    const sentAt: number[] = [];
    const queue = new SendQueue({
      ratePerMinute: 2,
      collapseMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      schedule: clock.schedule,
    });

    for (let i = 0; i < 4; i += 1) {
      queue.enqueue(1, async () => {
        sentAt.push(clock.now());
      });
    }
    await queue.idle();

    expect(sentAt).toHaveLength(4);
    // With rate 2/min: first two go immediately, the rest wait for the window.
    for (let i = 2; i < sentAt.length; i += 1) {
      const windowStart = sentAt[i]! - 60_000;
      const inWindow = sentAt.filter((t) => t > windowStart && t <= sentAt[i]!);
      expect(inWindow.length).toBeLessThanOrEqual(2);
    }
  });

  it('keeps chats independent', async () => {
    const clock = makeVirtualClock();
    const order: string[] = [];
    const queue = new SendQueue({
      ratePerMinute: 1,
      collapseMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
      schedule: clock.schedule,
    });
    queue.enqueue(1, async () => {
      order.push('chat1-a');
    });
    queue.enqueue(2, async () => {
      order.push('chat2-a');
    });
    await queue.idle();
    expect(order).toContain('chat1-a');
    expect(order).toContain('chat2-a');
  });

  it('collapses rapid card edits: latest edit wins inside the window', async () => {
    const clock = makeVirtualClock();
    const applied: string[] = [];
    const queue = new SendQueue({
      ratePerMinute: 100,
      collapseMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      schedule: clock.schedule,
    });

    queue.enqueueCardEdit(1, 'market-1', async () => {
      applied.push('v1');
    });
    await queue.idle();
    // Inside the collapse window: v2 deferred, v3 replaces v2.
    queue.enqueueCardEdit(1, 'market-1', async () => {
      applied.push('v2');
    });
    queue.enqueueCardEdit(1, 'market-1', async () => {
      applied.push('v3');
    });
    expect(applied).toEqual(['v1']);

    clock.advance(60_000);
    await queue.idle();
    expect(applied).toEqual(['v1', 'v3']);
  });

  it('does not collapse edits for different markets', async () => {
    const clock = makeVirtualClock();
    const applied: string[] = [];
    const queue = new SendQueue({
      ratePerMinute: 100,
      collapseMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      schedule: clock.schedule,
    });
    queue.enqueueCardEdit(1, 'market-1', async () => {
      applied.push('m1');
    });
    queue.enqueueCardEdit(1, 'market-2', async () => {
      applied.push('m2');
    });
    await queue.idle();
    expect(applied.sort()).toEqual(['m1', 'm2']);
  });

  it('urgent card edits cancel a deferred edit for the same key', async () => {
    const clock = makeVirtualClock();
    const applied: string[] = [];
    const queue = new SendQueue({
      ratePerMinute: 100,
      collapseMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      schedule: clock.schedule,
    });
    queue.enqueueCardEdit(1, 'market-1', async () => {
      applied.push('v1');
    });
    await queue.idle();
    // A passive edit lands inside the window and is deferred…
    queue.enqueueCardEdit(1, 'market-1', async () => {
      applied.push('passive');
    });
    // …then an urgent tap supersedes it immediately.
    queue.enqueueCardEdit(1, 'market-1', async () => {
      applied.push('urgent');
    }, { urgent: true });
    await queue.idle();
    expect(applied).toEqual(['v1', 'urgent']);
    // The cancelled deferred edit must never fire, even after the window.
    clock.advance(60_000);
    await queue.idle();
    expect(applied).toEqual(['v1', 'urgent']);
  });

  it('coalesces queued urgent edits so the latest card state wins', async () => {
    const clock = makeVirtualClock();
    const applied: string[] = [];
    const queue = new SendQueue({
      ratePerMinute: 1,
      collapseMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      schedule: clock.schedule,
    });
    queue.enqueue(1, async () => {
      applied.push('primer');
    });
    await queue.idle();

    queue.enqueueCardEdit(1, 'market-1', async () => {
      applied.push('frozen');
    }, { urgent: true });
    queue.enqueueCardEdit(1, 'market-1', async () => {
      applied.push('settled');
    }, { urgent: true });
    clock.advance(60_000);
    await queue.idle();

    expect(applied).toEqual(['primer', 'settled']);
  });

  it('urgent card edits jump ahead of queued narration', async () => {
    const clock = makeVirtualClock();
    const applied: string[] = [];
    const queue = new SendQueue({
      ratePerMinute: 1, // one slot per window forces ordering to matter
      collapseMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      schedule: clock.schedule,
    });
    // Prime the single rate slot so the next tasks must queue.
    queue.enqueue(1, async () => {
      applied.push('primer');
    });
    await queue.idle();
    queue.enqueue(1, async () => {
      applied.push('narration');
    });
    queue.enqueueCardEdit(1, 'market-1', async () => {
      applied.push('urgent');
    }, { urgent: true });
    clock.advance(60_000);
    await queue.idle();
    // Urgent unshifts ahead of the already-queued narration.
    expect(applied).toEqual(['primer', 'urgent', 'narration']);
  });

  it('keeps pumping after a task failure', async () => {
    const clock = makeVirtualClock();
    const errors: unknown[] = [];
    const applied: string[] = [];
    const queue = new SendQueue({
      ratePerMinute: 10,
      collapseMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
      schedule: clock.schedule,
      onError: (err) => errors.push(err),
    });
    queue.enqueue(1, async () => {
      throw new Error('telegram hiccup');
    });
    queue.enqueue(1, async () => {
      applied.push('after-failure');
    });
    await queue.idle();
    expect(errors).toHaveLength(1);
    expect(applied).toEqual(['after-failure']);
  });
});
