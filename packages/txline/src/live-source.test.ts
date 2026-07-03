import { describe, expect, it, vi } from 'vitest';
import type { MatchEvent, OddsInputs } from '@calledit/market-engine';
import type { OpenStreamOptions, StreamKind } from './client.js';
import { InMemoryCursorStore } from './event-source.js';
import { LiveSource, type LiveStreamClient } from './live-source.js';
import { silentLogger } from './logging.js';
import { oddsRecord, scoresRecord } from './test-fixtures.js';

const encoder = new TextEncoder();

/** SSE Response stand-in whose stream optionally stays open until aborted. */
function sseResponse(
  frames: string,
  options: { close: boolean; signal?: AbortSignal },
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (frames.length > 0) controller.enqueue(encoder.encode(frames));
      if (options.close) {
        controller.close();
        return;
      }
      options.signal?.addEventListener(
        'abort',
        () => {
          try {
            controller.error(new Error('stream aborted'));
          } catch {
            // already closed
          }
        },
        { once: true },
      );
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

const dataFrame = (id: string, record: unknown): string =>
  `id: ${id}\ndata: ${JSON.stringify(record)}\n\n`;

interface OpenStreamCall {
  kind: StreamKind;
  lastEventId: string | null | undefined;
}

function scriptedClient(
  script: (call: OpenStreamCall, callIndex: number, options?: OpenStreamOptions) => Response,
): { client: LiveStreamClient; calls: OpenStreamCall[] } {
  const calls: OpenStreamCall[] = [];
  const client: LiveStreamClient = {
    openStream: async (kind, options) => {
      const call: OpenStreamCall = { kind, lastEventId: options?.lastEventId };
      calls.push(call);
      return script(call, calls.length, options);
    },
  };
  return { client, calls };
}

describe('LiveSource — cursor resume', () => {
  it('persists Last-Event-ID per frame and resumes from it after a drop', async () => {
    const cursorStore = new InMemoryCursorStore();
    const goal1 = scoresRecord({ seq: 1, dataSoccer: { Goal: true, Participant: 1 } });
    const goal2 = scoresRecord({ seq: 2, dataSoccer: { Goal: true, Participant: 2 } });

    const { client, calls } = scriptedClient((_call, callIndex, options) => {
      if (callIndex === 1) {
        // Two events, then the server closes the stream.
        return sseResponse(dataFrame('100:0', goal1) + dataFrame('100:1', goal2), { close: true });
      }
      return sseResponse('', { close: false, signal: options?.signal });
    });

    const events: MatchEvent[] = [];
    const source = new LiveSource({
      client,
      cursorStore,
      streams: ['scores'],
      reconnectBaseDelayMs: 1,
      heartbeatTimeoutMs: 5_000,
      logger: silentLogger,
    });
    source.start(async (event) => {
      events.push(event);
    });

    try {
      await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
      expect(calls[0]?.lastEventId).toBeNull();
      expect(calls[1]?.lastEventId).toBe('100:1');
      expect(await cursorStore.get('txline:scores:all')).toBe('100:1');
      expect(events.map((e) => [e.kind, e.seq])).toEqual([
        ['goal', 1],
        ['goal', 2],
      ]);
    } finally {
      source.stop();
    }
  });

  it('namespaces the cursor by fixture filter', () => {
    const source = new LiveSource({
      client: scriptedClient(() => sseResponse('', { close: true })).client,
      cursorStore: new InMemoryCursorStore(),
      fixtureId: 42,
      logger: silentLogger,
    });
    expect(source.cursorName('scores')).toBe('txline:scores:42');
    expect(source.cursorName('odds')).toBe('txline:odds:42');
  });
});

describe('LiveSource — heartbeat timeout and gap-fill', () => {
  it('reconnects after heartbeat silence and invokes the gap-fill hook', async () => {
    const cursorStore = new InMemoryCursorStore();
    const record = scoresRecord({ seq: 1, dataSoccer: { Goal: true } });
    const { client, calls } = scriptedClient((_call, callIndex, options) => {
      if (callIndex === 1) {
        // One event, then silence — the watchdog must tear this down.
        return sseResponse(dataFrame('200:0', record), { close: false, signal: options?.signal });
      }
      return sseResponse('', { close: false, signal: options?.signal });
    });

    const gapFill = vi.fn(async () => {});
    const source = new LiveSource({
      client,
      cursorStore,
      streams: ['scores'],
      heartbeatTimeoutMs: 25,
      reconnectBaseDelayMs: 1,
      gapFill,
      logger: silentLogger,
    });
    source.start(async () => {});

    try {
      await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
      expect(calls[1]?.lastEventId).toBe('200:0');
      await vi.waitFor(() => expect(gapFill).toHaveBeenCalledWith('scores', '200:0'));
      // First connect must NOT gap-fill — only reconnects do.
      expect(gapFill).toHaveBeenCalledTimes(1);
    } finally {
      source.stop();
    }
  });

  it('heartbeat frames keep the connection alive without touching the cursor', async () => {
    const cursorStore = new InMemoryCursorStore();
    const { client, calls } = scriptedClient((_call, _callIndex, options) =>
      sseResponse('event: heartbeat\ndata: {"Ts": 1}\n\n', { close: false, signal: options?.signal }),
    );
    const source = new LiveSource({
      client,
      cursorStore,
      streams: ['scores'],
      heartbeatTimeoutMs: 5_000,
      reconnectBaseDelayMs: 1,
      logger: silentLogger,
    });
    source.start(async () => {});
    try {
      await vi.waitFor(() => expect(calls.length).toBe(1));
      // Give the loop a beat: no reconnect and no cursor writes should happen.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls.length).toBe(1);
      expect(await cursorStore.get('txline:scores:all')).toBeNull();
    } finally {
      source.stop();
    }
  });
});

describe('LiveSource — odds stream', () => {
  it('emits OddsInputs for usable records and a single odds_suspension edge event', async () => {
    const usable = oddsRecord({ MessageId: 'm-1', Ts: 1_000 });
    const suspended1 = oddsRecord({ MessageId: 'm-2', Ts: 2_000, GameState: 'Suspended' });
    const suspended2 = oddsRecord({ MessageId: 'm-3', Ts: 3_000, GameState: 'Suspended' });

    const { client } = scriptedClient((_call, callIndex, options) => {
      if (callIndex === 1) {
        return sseResponse(
          dataFrame('300:0', usable) + dataFrame('300:1', suspended1) + dataFrame('300:2', suspended2),
          { close: false, signal: options?.signal },
        );
      }
      return sseResponse('', { close: false, signal: options?.signal });
    });

    const events: MatchEvent[] = [];
    const oddsInputs: Array<{ fixtureId: number; inputs: OddsInputs }> = [];
    const source = new LiveSource({
      client,
      cursorStore: new InMemoryCursorStore(),
      streams: ['odds'],
      heartbeatTimeoutMs: 5_000,
      reconnectBaseDelayMs: 1,
      onOddsInputs: (fixtureId, inputs) => oddsInputs.push({ fixtureId, inputs }),
      logger: silentLogger,
    });
    source.start(async (event) => {
      events.push(event);
    });

    try {
      await vi.waitFor(() => {
        expect(oddsInputs.length).toBe(1);
        expect(events.length).toBe(1);
      });
      expect(oddsInputs[0]?.inputs.oddsMessageId).toBe('m-1');
      expect(events[0]?.kind).toBe('odds_suspension');
      // Edge-triggered: the second consecutive suspended record adds nothing.
      expect(events[0]?.seq).toBe(2_000);
    } finally {
      source.stop();
    }
  });

  it('ignores suspensions on half-time markets', async () => {
    const halfSuspended = oddsRecord({
      MessageId: 'm-half',
      Ts: 5_000,
      MarketPeriod: '1H',
      GameState: 'Suspended',
    });
    const { client, calls } = scriptedClient((_call, _callIndex, options) =>
      sseResponse(dataFrame('400:0', halfSuspended), { close: false, signal: options?.signal }),
    );
    const events: MatchEvent[] = [];
    const source = new LiveSource({
      client,
      cursorStore: new InMemoryCursorStore(),
      streams: ['odds'],
      heartbeatTimeoutMs: 5_000,
      reconnectBaseDelayMs: 1,
      logger: silentLogger,
    });
    source.start(async (event) => {
      events.push(event);
    });
    try {
      await vi.waitFor(() => expect(calls.length).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(events).toEqual([]);
    } finally {
      source.stop();
    }
  });
});

describe('LiveSource — lifecycle', () => {
  it('rejects a second start()', () => {
    const source = new LiveSource({
      client: scriptedClient(() => sseResponse('', { close: true })).client,
      cursorStore: new InMemoryCursorStore(),
      streams: ['scores'],
      logger: silentLogger,
    });
    source.start(async () => {});
    expect(() => source.start(async () => {})).toThrow(/started twice|called twice/);
    source.stop();
  });
});
