export class TelegramIngressWorkerLifecycle {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly leasing = new Set<Promise<void>>();
  private stopped = false;

  get leasingStopped(): boolean {
    return this.stopped;
  }

  stopLeasing(): void {
    this.stopped = true;
  }

  beginLease(): () => void {
    const barrier = createBarrier();
    this.leasing.add(barrier.done);
    return () => {
      barrier.resolve();
      this.leasing.delete(barrier.done);
    };
  }

  track(task: Promise<void>): Promise<void> {
    let tracked: Promise<void> = Promise.resolve();
    tracked = task.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
    return tracked;
  }

  async drain(signal: AbortSignal): Promise<void> {
    this.stopLeasing();
    while (!signal.aborted) {
      const active = [...this.leasing, ...this.inFlight];
      if (active.length === 0) return;
      await waitForActiveWork(active, signal);
    }
  }

  unfinished(): number {
    return this.inFlight.size;
  }
}

function createBarrier(): { readonly done: Promise<void>; readonly resolve: () => void } {
  let release: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { done, resolve: release };
}

function waitForActiveWork(active: readonly Promise<void>[], signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    void Promise.allSettled(active).then(finish);
  });
}
