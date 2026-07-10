import { describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '../log.js';
import {
  registerBotErrorHandler,
  type BotErrorRegistrar,
} from './bot.js';

type ErrorLog = {
  readonly event: string;
  readonly fields: LogFields | undefined;
};

class CatchHarness implements BotErrorRegistrar {
  private handler: ((error: { readonly error: unknown }) => unknown) | undefined;

  catch(handler: (error: { readonly error: unknown }) => unknown): void {
    this.handler = handler;
  }

  trigger(error: unknown): void {
    const handler = this.handler;
    if (handler === undefined) throw new Error('catch handler not registered');
    handler({ error });
  }
}

function makeLogger(logs: ErrorLog[]): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: (event, fields) => logs.push({ event, fields }),
    child: () => makeLogger(logs),
  };
}

describe('bot error boundary', () => {
  it('redacts secret-bearing handler errors before structured logging', () => {
    // Given a registered bot catcher and an exception containing credential material
    const logs: ErrorLog[] = [];
    const bot = new CatchHarness();
    registerBotErrorHandler(bot, makeLogger(logs));
    const secret = 'Bearer route-credential initData wallet-private-key';

    // When grammY reports the raw handler exception
    bot.trigger(new Error(secret));

    // Then the log contains only a stable reason and no exception text
    expect(logs).toEqual([
      { event: 'bot_update_failed', fields: { reason: 'bot_handler_exception' } },
    ]);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });
});
