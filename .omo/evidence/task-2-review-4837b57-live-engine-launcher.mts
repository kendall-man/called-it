import {
  closeActiveServer,
  startHarness,
} from '../../apps/engine/src/api/server-test-harness.ts';
import { createTelegramIngressHandler } from '../../apps/engine/src/api/telegram-ingress-boundary.ts';

type Fields = Readonly<Record<string, unknown>>;

function logger(bound: Fields = {}) {
  const emit = (level: string, event: string, fields: Fields = {}): void => {
    process.stderr.write(`${JSON.stringify({ level, event, ...bound, ...fields })}\n`);
  };

  return {
    info: (event: string, fields?: Fields) => emit('info', event, fields),
    warn: (event: string, fields?: Fields) => emit('warn', event, fields),
    error: (event: string, fields?: Fields) => emit('error', event, fields),
    child: (fields: Fields) => logger({ ...bound, ...fields }),
  };
}

async function shutdown(): Promise<void> {
  await closeActiveServer();
  process.exit(0);
}

async function main(): Promise<void> {
  const harness = await startHarness({
    log: logger(),
    telegramIngress: {
      accept: createTelegramIngressHandler(async (update) => {
        if (update.message?.text === 'SENTINEL_TRIGGER_FAILURE') {
          throw new Error(
            'SENTINEL_RAW_ERROR Authorization Bearer SENTINEL_AUTH ' +
            'initData=SENTINEL_INIT signature=SENTINEL_SIGNATURE ' +
            'pubkey=SENTINEL_PUBKEY',
          );
        }
      }),
    },
  });

  process.stdout.write(`BASE_URL=${harness.base}\n`);
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  setTimeout(() => void shutdown(), 300_000);
}

void main();
