/**
 * Split-webhook loopback. The native Telegram channel (telegram.ts) stays the
 * single front door Telegram talks to; it forwards group/command/callback
 * updates to the engine unchanged. Conversational private updates are instead
 * re-dispatched here to the Chat SDK bridge's own webhook route, an internal
 * HTTP POST back to this process. That inbound request is what sets eve's
 * Chat SDK webhook context (ActiveWebhookKey), which the bridge's `send`
 * requires to start a streaming session — so the loopback is not incidental,
 * it is the only way to hand a private update to the rich streaming path
 * without letting the Chat SDK become the sole front door (which would drop
 * plain group /commands and break engine claim detection).
 *
 * A loopback failure only costs one conversational reply (private updates
 * never carry engine work), so failures are logged and swallowed rather than
 * surfaced to Telegram for retry, which would risk a duplicate reply.
 */

/** Route the Chat SDK bridge mounts its Telegram adapter webhook on. */
export const CHATSDK_TELEGRAM_ROUTE = '/eve/v1/callie';

/** How long the front-door webhook waits for the loopback to be accepted. */
const LOOPBACK_TIMEOUT_MS = 10_000;

/** Destinations `forwardEngineMessage` reports for an inbound message. */
export type ConciergeDispatchDestination = 'concierge' | 'handled' | 'draining';

/** What the front door does with an inbound message after routing. */
export type ConciergeDispatchAction = 'loopback' | 'engine' | 'drop';

/**
 * Maps a routed destination to the front-door action: a conversational
 * private update loops back to the Chat SDK bridge, an engine-owned update was
 * already forwarded, and a draining update is dropped.
 */
export function conciergeDispatchFor(
  destination: ConciergeDispatchDestination,
): ConciergeDispatchAction {
  switch (destination) {
    case 'concierge':
      return 'loopback';
    case 'handled':
      return 'engine';
    case 'draining':
      return 'drop';
  }
}

/** Loopback origin for the local Nitro server: same process, same port. */
export function conciergeLoopbackOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export interface ConciergeLoopbackOptions {
  readonly origin: string;
  readonly route: string;
  readonly secretToken: string;
  readonly fetch: typeof fetch;
  /** Monotonic synthetic update-id source; defaults to a time-seeded counter. */
  readonly nextUpdateId?: () => number;
}

export interface ConciergeLoopback {
  /** Re-dispatches one raw Telegram message to the Chat SDK bridge route. */
  dispatch(rawMessage: Record<string, unknown>): Promise<void>;
}

export function createConciergeLoopback(
  options: ConciergeLoopbackOptions,
): ConciergeLoopback {
  const url = `${options.origin.replace(/\/$/, '')}${options.route}`;
  const nextUpdateId = options.nextUpdateId ?? defaultUpdateIdCounter();
  return {
    async dispatch(rawMessage: Record<string, unknown>): Promise<void> {
      try {
        const response = await options.fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-telegram-bot-api-secret-token': options.secretToken,
          },
          body: JSON.stringify({ update_id: nextUpdateId(), message: rawMessage }),
          signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
        });
        if (!response.ok) {
          logLoopbackDisabled(`chatsdk_loopback_status_${response.status}`);
        }
      } catch (error) {
        logLoopbackDisabled(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function defaultUpdateIdCounter(): () => number {
  let updateId = Math.floor(Date.now() / 1000);
  return () => {
    updateId += 1;
    return updateId;
  };
}

function logLoopbackDisabled(reason: string): void {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      event: 'chatsdk_loopback_failed',
      reason,
    })}\n`,
  );
}
