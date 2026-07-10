import { describe, expect, it } from 'vitest';
import {
  OwnedTelegramSender,
  type OwnedTelegramPlanResult,
  type OwnedTelegramSenderDb,
  type OwnedTelegramSendInput,
} from './owned-sender.js';

const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();

function plan(
  state: Extract<OwnedTelegramPlanResult, { readonly ok: true }>['state'] = 'planned',
  messageId: number | null = null,
  duplicate = false,
) {
  return { ok: true as const, id: 'job-1', state, chatId: 1, domainKind: 'market_card', domainId: 'market-1', messageId, duplicate };
}

function createDb(events: string[]): OwnedTelegramSenderDb {
  return {
    planOutbound: async () => { events.push('plan'); return plan(); },
    startOutbound: async () => {
      events.push('start');
      return { ok: true, id: 'job-1', state: 'sending', chatId: 1, domainKind: 'market_card', domainId: 'market-1', leaseExpiresAt };
    },
    markOutboundOwned: async () => { events.push('own'); return { ok: true, state: 'owned', duplicate: false }; },
    markOutboundUncertain: async () => {
      events.push('uncertain');
      return { ok: true, state: 'ownership_uncertain', duplicate: false };
    },
  };
}

function createSender(events: string[], overrides: Partial<OwnedTelegramSenderDb> = {}): OwnedTelegramSender {
  return new OwnedTelegramSender({
    db: { ...createDb(events), ...overrides }, workerId: 'worker-1', leaseMs: 1_000, retryDelayMs: 0,
    wait: async () => undefined,
  });
}

function createInput(overrides: Partial<OwnedTelegramSendInput> = {}): OwnedTelegramSendInput {
  return { logicalKey: 'market-card:1', chatId: 1, domainKind: 'market_card', domainId: 'market-1', send: async () => 42, ...overrides };
}

function deferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve(value: T): void { resolve?.(value); } };
}

describe('OwnedTelegramSender', () => {
  it('records durable ownership after sending and leaves completion to the recovery worker', async () => {
    const events: string[] = [];
    const result = await createSender(events).send(createInput({
      send: async () => { events.push('send'); return 42; },
      recordAuthoritativeMessageId: async () => { events.push('record'); },
    }));

    expect(result).toEqual({ kind: 'owned', jobId: 'job-1', messageId: 42, state: 'owned' });
    expect(events).toEqual(['plan', 'start', 'send', 'record', 'own']);
  });

  it('coalesces concurrent calls for the same logical identity and sends once', async () => {
    const events: string[] = [];
    const started = deferred<void>();
    const sent = deferred<number>();
    const sender = createSender(events);
    const input = createInput({ send: async () => { events.push('send'); started.resolve(undefined); return sent.promise; } });

    const first = sender.send(input);
    await started.promise;
    const second = sender.send(input);
    sent.resolve(42);

    const owned = { kind: 'owned', jobId: 'job-1', messageId: 42, state: 'owned' };
    await expect(Promise.all([first, second])).resolves.toEqual([owned, owned]);
    expect(events.filter((event) => event === 'send')).toHaveLength(1);
  });

  it('rejects a different chat or domain identity while the logical key is coalesced', async () => {
    const events: string[] = [];
    const started = deferred<void>();
    const sent = deferred<number>();
    const sender = createSender(events);
    const first = sender.send(createInput({ send: async () => { events.push('send'); started.resolve(undefined); return sent.promise; } }));
    await started.promise;
    const conflicting = sender.send(createInput({ chatId: 2, domainId: 'market-2' }));
    sent.resolve(42);

    await expect(conflicting).resolves.toEqual({ kind: 'skipped', jobId: null, state: null, code: 'logical_key_conflict' });
    await first;
    expect(events.filter((event) => event === 'send')).toHaveLength(1);
  });

  it('retries a lost ownership response idempotently without resending', async () => {
    const events: string[] = [];
    let ownershipAttempts = 0;
    const sender = createSender(events, {
      markOutboundOwned: async () => {
        ownershipAttempts += 1;
        events.push('own');
        if (ownershipAttempts === 1) throw new Error('response lost');
        return { ok: true, state: 'owned', duplicate: true };
      },
    });

    await sender.send(createInput({ send: async () => { events.push('send'); return 42; } }));
    expect(ownershipAttempts).toBe(2);
    expect(events.filter((event) => event === 'send')).toHaveLength(1);
  });

  it('persists uncertainty when the Telegram call fails after the send lease starts', async () => {
    const events: string[] = [];
    const result = await createSender(events).send(createInput({
      send: async () => { events.push('send'); throw new Error('network outcome unknown'); },
    }));

    expect(result).toEqual({ kind: 'uncertain', jobId: 'job-1', messageId: null, state: 'ownership_uncertain' });
    expect(events).toEqual(['plan', 'start', 'send', 'uncertain']);
  });

  it('moves an ownership conflict to durable uncertainty without retrying the Telegram send', async () => {
    const events: string[] = [];
    const sender = createSender(events, {
      markOutboundOwned: async () => { events.push('own'); return { ok: false, code: 'ownership_conflict' }; },
    });

    const result = await sender.send(createInput({ send: async () => { events.push('send'); return 42; } }));
    expect(result).toEqual({ kind: 'uncertain', jobId: 'job-1', messageId: 42, state: 'ownership_uncertain' });
    expect(events).toEqual(['plan', 'start', 'send', 'own', 'uncertain']);
  });

  it('does not send a job recovered after durable ownership', async () => {
    const events: string[] = [];
    const sender = createSender(events, { planOutbound: async () => { events.push('plan'); return plan('owned', 42, true); } });

    await expect(sender.send(createInput({ send: async () => { events.push('send'); return 42; } }))).resolves.toEqual({
      kind: 'owned', jobId: 'job-1', messageId: 42, state: 'owned',
    });
    expect(events).toEqual(['plan']);
  });

  it('does not resend a job that is already ownership uncertain', async () => {
    const events: string[] = [];
    const sender = createSender(events, { planOutbound: async () => { events.push('plan'); return plan('ownership_uncertain', null, true); } });

    await expect(sender.send(createInput({ send: async () => { events.push('send'); return 42; } }))).resolves.toEqual({
      kind: 'skipped', jobId: 'job-1', state: 'ownership_uncertain', code: 'outbound_not_planned',
    });
    expect(events).toEqual(['plan']);
  });

  it('signals drain timeout when an in-flight send outlives the abort deadline', async () => {
    const events: string[] = [];
    const started = deferred<void>();
    const sent = deferred<number>();
    const sender = createSender(events);
    const active = sender.send(createInput({ send: async () => { started.resolve(undefined); return sent.promise; } }));
    await started.promise;
    const controller = new AbortController();
    controller.abort();

    await expect(sender.drain(controller.signal)).resolves.toEqual({ kind: 'timeout', unfinished: 1 });
    sent.resolve(42);
    await active;
  });
});
