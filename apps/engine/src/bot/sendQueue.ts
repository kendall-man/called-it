/**
 * Per-chat outbound queue.
 *
 * - Rate limit: a sliding-window cap (~18 msg/min per chat) so goal bursts
 *   never trip Telegram's ~20/min group ceiling.
 * - Card-edit collapse: edits sharing a collapse key (one per market card)
 *   run at most once per collapse window; while a window is closed the latest
 *   pending edit replaces any earlier one (latest state wins, PRD story 29).
 *
 * Clock and timers are injectable so the behavior is unit-testable.
 */

export type SendTask = () => Promise<unknown>;

export interface SendQueueOptions {
  ratePerMinute: number;
  collapseMs: number;
  now?: () => number;
  /** Sleeps inside the pump loop; tests inject a virtual clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Defers collapsed edits; tests inject a manual scheduler. */
  schedule?: (fn: () => void, ms: number) => () => void;
  onError?: (err: unknown, context: { chatId: number }) => void;
}

const RATE_WINDOW_MS = 60_000;

interface ChatState {
  tasks: SendTask[];
  sentAt: number[];
  pumping: boolean;
  idleResolvers: Array<() => void>;
}

interface DeferredEdit {
  task: SendTask;
  cancel: () => void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

export class SendQueue {
  private readonly chats = new Map<number, ChatState>();
  private readonly lastEditAt = new Map<string, number>();
  private readonly deferredEdits = new Map<string, DeferredEdit>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly onError: (err: unknown, context: { chatId: number }) => void;
  private stopped = false;

  constructor(private readonly options: SendQueueOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.schedule = options.schedule ?? defaultSchedule;
    this.onError = options.onError ?? (() => undefined);
  }

  /** Enqueue an ordinary send (message, reaction follow-up, etc.). */
  enqueue(chatId: number, task: SendTask): void {
    if (this.stopped) return;
    const state = this.chatState(chatId);
    state.tasks.push(task);
    void this.pump(chatId, state);
  }

  /** Enqueue a task whose durable caller must wait for its Telegram result. */
  enqueueAndWait<Result>(chatId: number, task: () => Promise<Result>): Promise<Result> {
    if (this.stopped) return Promise.reject(new SendQueueStoppedError());
    return new Promise<Result>((resolve, reject) => {
      this.enqueue(chatId, async () => {
        try {
          const result = await task();
          resolve(result);
          return result;
        } catch (error) {
          reject(error);
          throw error;
        }
      });
    });
  }

  /**
   * Enqueue a card edit under a collapse key (use the market id). Within the
   * collapse window the newest edit replaces any deferred one.
   */
  enqueueCardEdit(chatId: number, collapseKey: string, task: SendTask): void {
    if (this.stopped) return;
    const key = `${chatId}:${collapseKey}`;
    const existing = this.deferredEdits.get(key);
    if (existing) {
      existing.task = task; // latest wins
      return;
    }
    const last = this.lastEditAt.get(key) ?? Number.NEGATIVE_INFINITY;
    const nowMs = this.now();
    if (nowMs - last >= this.options.collapseMs) {
      this.lastEditAt.set(key, nowMs);
      this.enqueue(chatId, task);
      return;
    }
    const entry: DeferredEdit = { task, cancel: () => undefined };
    const delay = Math.max(0, last + this.options.collapseMs - nowMs);
    entry.cancel = this.schedule(() => {
      this.deferredEdits.delete(key);
      this.lastEditAt.set(key, this.now());
      this.enqueue(chatId, entry.task);
    }, delay);
    this.deferredEdits.set(key, entry);
  }

  /** Resolves when every chat queue is drained (deferred edits not included). */
  async idle(): Promise<void> {
    await Promise.all(
      [...this.chats.values()].map(
        (state) =>
          new Promise<void>((resolve) => {
            if (!state.pumping && state.tasks.length === 0) resolve();
            else state.idleResolvers.push(resolve);
          }),
      ),
    );
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.deferredEdits.values()) entry.cancel();
    this.deferredEdits.clear();
  }

  private chatState(chatId: number): ChatState {
    let state = this.chats.get(chatId);
    if (!state) {
      state = { tasks: [], sentAt: [], pumping: false, idleResolvers: [] };
      this.chats.set(chatId, state);
    }
    return state;
  }

  private msUntilSlot(state: ChatState): number {
    const nowMs = this.now();
    const windowStart = nowMs - RATE_WINDOW_MS;
    state.sentAt = state.sentAt.filter((t) => t > windowStart);
    if (state.sentAt.length < this.options.ratePerMinute) return 0;
    const oldest = state.sentAt[0];
    return oldest === undefined ? 0 : Math.max(0, oldest + RATE_WINDOW_MS - nowMs);
  }

  private async pump(chatId: number, state: ChatState): Promise<void> {
    if (state.pumping) return;
    state.pumping = true;
    try {
      while (state.tasks.length > 0 && !this.stopped) {
        const wait = this.msUntilSlot(state);
        if (wait > 0) await this.sleep(wait);
        const task = state.tasks.shift();
        if (!task) break;
        state.sentAt.push(this.now());
        try {
          await task();
        } catch (err) {
          this.onError(err, { chatId });
        }
      }
    } finally {
      state.pumping = false;
      for (const resolve of state.idleResolvers.splice(0)) resolve();
    }
  }
}

export class SendQueueStoppedError extends Error {
  readonly name = 'SendQueueStoppedError';

  constructor() {
    super('telegram send queue is stopped');
  }
}
