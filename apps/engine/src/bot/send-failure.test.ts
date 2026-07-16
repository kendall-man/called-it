import { readFileSync } from 'node:fs';
import { GrammyError } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../log.js';
import type { LogFields, Logger } from '../log.js';
import * as sendFailureModule from './send-failure.js';
import type { SendQueue } from './sendQueue.js';

type EngineSendQueueModule = {
  readonly createEngineSendQueue: (log: Logger) => SendQueue;
};

function hasEngineSendQueueFactory(candidate: object): candidate is EngineSendQueueModule {
  return 'createEngineSendQueue' in candidate
    && typeof candidate.createEngineSendQueue === 'function';
}

function serializeSendFailure(fields: LogFields): string {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  createLogger({ app: 'calledit-engine' }).error('send_failed', fields);
  return write.mock.calls.map((call) => String(call[0])).join('');
}

afterEach(() => vi.restoreAllMocks());

describe('engine send queue wiring', () => {
  it('constructs the production queue only through the audited factory', () => {
    // Given the executable engine entrypoint source
    const source = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

    // When its queue construction is inspected
    const factoryCalls = source.match(/createEngineSendQueue\(log\)/g) ?? [];

    // Then main cannot bypass the production failure handler with inline wiring
    expect(factoryCalls).toHaveLength(1);
    expect(source).not.toContain('new SendQueue(');
    expect(source).not.toContain("from './bot/sendQueue.js'");
  });

  it('contains no raw exception emission and classifies command-registration failures', () => {
    // Given the executable engine entrypoint source
    const source = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
    const unsafePatterns = [
      ['stringified exception', /\bString\s*\(\s*(?:err|error)\s*\)/],
      ['exception message', /\b(?:err|error)\.message\b/],
      ['console error', /console\.error\s*\(/],
      ['raw error field', /\berror\s*:\s*(?:err|error)\b/],
    ] as const;

    // When raw exception sinks are audited
    const violations = unsafePatterns
      .filter(([, pattern]) => pattern.test(source))
      .map(([label]) => label);

    // Then every main failure path uses stable fields instead
    expect(violations).toEqual([]);
    expect(source).toContain("log.warn('set_commands_failed', classifySendFailure(err));");
  });

  it('logs an actual production queue failure with stable fields and no private context', async () => {
    // Given the exact factory exported for main and a private failing Telegram send
    expect(hasEngineSendQueueFactory(sendFailureModule)).toBe(true);
    if (!hasEngineSendQueueFactory(sendFailureModule)) return;
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const queue = sendFailureModule.createEngineSendQueue(createLogger({ app: 'calledit-engine' }));
    const queueChatId = -1_005_555_555_501;
    const payloadChatId = -1_005_555_555_502;
    const groupId = -1_005_555_555_503;
    const userId = 5_555_555_504;
    const url = 'http://localhost:3000/g/production-wiring-private';
    const payloadSentinel = 'FACTORY_PRIVATE_PAYLOAD_SENTINEL';
    const exceptionSentinel = 'FACTORY_PRIVATE_EXCEPTION_SENTINEL';
    const error = new GrammyError(
      `private queue exception ${exceptionSentinel}`,
      {
        ok: false,
        error_code: 400,
        description: `Bad Request: BUTTON_URL_INVALID ${exceptionSentinel}`,
        parameters: {},
      },
      'sendMessage',
      {
        chat_id: payloadChatId,
        group_id: groupId,
        user_id: userId,
        reply_markup: { inline_keyboard: [[{ text: payloadSentinel, url }]] },
      },
    );

    // When the real queue catches the failed send through its production onError handler
    queue.enqueue(queueChatId, async () => {
      throw error;
    });
    await queue.idle();
    queue.stop();

    // Then the real JSON log contains exactly stable operational fields
    expect(write).toHaveBeenCalledTimes(1);
    const serialized = write.mock.calls.map((call) => String(call[0])).join('');
    const logged: unknown = JSON.parse(serialized);
    expect(logged).toEqual({
      ts: expect.any(String),
      level: 'error',
      event: 'send_failed',
      app: 'calledit-engine',
      failureKind: 'telegram_api',
      telegramMethod: 'send_message',
      telegramErrorCode: 400,
      reason: 'button_url_invalid',
    });
    for (const forbidden of [
      String(queueChatId), String(payloadChatId), String(groupId), String(userId),
      url, payloadSentinel, exceptionSentinel, '"chatId":', '"chat_id":',
      '"group_id":', '"user_id":', '"error":', '"payload":', '"reply_markup":',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('classifySendFailure', () => {
  it('maps BUTTON_URL_INVALID to stable fields without serializing private Telegram context', () => {
    // Given grammY reports an invalid button with private data in every unsafe surface
    const chatId = -1_009_876_543_210;
    const groupId = -1_008_765_432_109;
    const userId = 9_876_543_210;
    const url = 'http://localhost:3000/g/private-group-sentinel';
    const payloadSentinel = 'PRIVATE_PAYLOAD_SENTINEL';
    const exceptionSentinel = 'PRIVATE_EXCEPTION_SENTINEL';
    const error = new GrammyError(
      `send failed for ${chatId}/${groupId}/${userId} ${url} ${payloadSentinel} ${exceptionSentinel}`,
      {
        ok: false,
        error_code: 400,
        description: `Bad Request: BUTTON_URL_INVALID ${exceptionSentinel}`,
        parameters: {},
      },
      'sendMessage',
      {
        chat_id: chatId,
        group_id: groupId,
        user_id: userId,
        reply_markup: { inline_keyboard: [[{ text: payloadSentinel, url }]] },
      },
    );

    // When the queue failure is classified and serialized by the production logger
    const fields = sendFailureModule.classifySendFailure(error);
    const serialized = serializeSendFailure(fields);

    // Then only stable operational classifiers survive
    expect(fields).toEqual({
      failureKind: 'telegram_api',
      telegramMethod: 'send_message',
      telegramErrorCode: 400,
      reason: 'button_url_invalid',
    });
    for (const forbidden of [
      String(chatId), String(groupId), String(userId), url, payloadSentinel, exceptionSentinel,
      'chat_id', 'group_id', 'user_id', 'reply_markup', 'inline_keyboard',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('fully redacts unknown failures instead of serializing exception contents', () => {
    // Given an unclassified exception carries private data in its message and cause
    const sentinel = 'UNKNOWN_PRIVATE_SENTINEL';
    const error = new Error(`unclassified failure ${sentinel}`, {
      cause: { chatId: -1_001_234_567_890, url: `https://private.invalid/${sentinel}` },
    });

    // When the failure is classified and serialized
    const fields = sendFailureModule.classifySendFailure(error);
    const serialized = serializeSendFailure(fields);

    // Then the logger receives no value derived from the exception
    expect(fields).toEqual({ failureKind: 'unknown' });
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain('unclassified failure');
    expect(serialized).not.toContain('private.invalid');
    expect(serialized).not.toContain('-1001234567890');
  });
});
