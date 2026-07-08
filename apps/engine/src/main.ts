/**
 * Called It engine — the single long-running process:
 * grammY bot (long polling via @grammyjs/runner) + TxLINE ingest supervisor +
 * settlement loop + async proof worker + cron ticks. Booting validates the
 * environment with zod and fails loudly on misconfiguration.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { run } from '@grammyjs/runner';
import { TUNABLES } from '@calledit/market-engine';
import { loadEnv } from './env.js';
import { createLogger } from './log.js';
import { createDeps } from './wiring.js';
import { ENGINE } from './engineConstants.js';
import { SendQueue } from './bot/sendQueue.js';
import { createPoster } from './bot/poster.js';
import { createSay } from './bot/copy.js';
import { EntityCache } from './bot/entities.js';
import { LlmBudget } from './bot/budget.js';
import { BOT_COMMANDS, registerBotHandlers } from './bot/bot.js';
import type { HandlerCtx } from './bot/context.js';
import { ProofWorker } from './proofs/worker.js';
import { Settler } from './settle/settler.js';
import { IngestSupervisor } from './ingest/supervisor.js';
import { startCrons } from './cron/index.js';
import { startEngineApi } from './api/server.js';

/**
 * Load the repo-root `.env` into process.env for local/dev runs. Production
 * hosts (Railway/Fly) inject env vars directly and ship no file, so a missing
 * `.env` is not an error. Walks up from this module so it resolves whether run
 * from `src` (tsx) or `dist` (node) and regardless of the caller's cwd. Values
 * already present in the environment win, so platform overrides are respected.
 */
function loadDotEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const log = createLogger({ app: 'calledit-engine' });
  const env = loadEnv();

  const queue = new SendQueue({
    ratePerMinute: ENGINE.SEND_RATE_PER_MINUTE,
    collapseMs: TUNABLES.CARD_EDIT_COLLAPSE_MS,
    onError: (err, context) => log.error('send_failed', { chatId: context.chatId, error: String(err) }),
  });

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  bot.api.config.use(autoRetry());

  // The poster exists before deps so the wager module can post deposit/
  // withdrawal notifications through the same rate-limited queue.
  const poster = createPoster(bot.api, queue, log);
  const deps = await createDeps(env, log, poster);

  // The wager module is the product now — SOL is the only currency. A boot with
  // it unwired (missing treasury keypair / flag) would silently mint nothing
  // and take no bets, so fail loud instead of limping.
  if (deps.wager === null) {
    throw new Error(
      'wager module is required: set WAGER_MODE_ENABLED=true and a valid WAGER_TREASURY_KEYPAIR_B58',
    );
  }

  const say = createSay(deps.agent, log);
  const proofWorker = new ProofWorker(deps);
  const settler = new Settler(deps, poster, say, proofWorker);
  const supervisor = new IngestSupervisor(deps, settler);

  const handlerCtx: HandlerCtx = {
    deps,
    queue,
    poster,
    say,
    supervisor,
    entities: new EntityCache(deps.db),
    budget: new LlmBudget(),
  };

  supervisor.onReplayFinished = (groupId, fixtureId) => {
    void (async () => {
      const fixture = await deps.db.getFixture(fixtureId);
      const label = fixture ? `${fixture.p1_name} vs ${fixture.p2_name}` : `fixture ${fixtureId}`;
      poster.post(groupId, await say('replay_finished', { fixture: label }));
    })();
  };

  registerBotHandlers(bot, handlerCtx);

  await bot.api.setMyCommands([...BOT_COMMANDS]).catch((err) => {
    log.warn('set_commands_failed', { error: String(err) });
  });

  const crons = startCrons({ deps, poster, say, settler, supervisor });
  const webhookIngress = env.TELEGRAM_INGRESS === 'webhook';
  if (webhookIngress && !env.ENGINE_API_TOKEN) {
    throw new Error('TELEGRAM_INGRESS=webhook requires ENGINE_API_TOKEN (updates arrive via the API)');
  }
  const apiServer = startEngineApi({
    deps,
    poster,
    env,
    log,
    ...(webhookIngress
      ? {
          handleTelegramUpdate: (update: Record<string, unknown>) =>
            bot.handleUpdate(update as unknown as Parameters<typeof bot.handleUpdate>[0]),
        }
      : {}),
  });
  // Webhook ingress: the concierge owns getUpdates' replacement (the webhook)
  // and forwards; polling here would 409 against the registered webhook.
  let runner: ReturnType<typeof run> | null = null;
  if (webhookIngress) {
    await bot.init(); // handleUpdate needs botInfo, which run() normally fetches
  } else {
    runner = run(bot);
  }
  log.info('engine_up', {
    webBaseUrl: env.WEB_BASE_URL,
    proofSubmitter: deps.proofSubmitter !== null,
    api: apiServer !== null,
    ingress: env.TELEGRAM_INGRESS,
    wagerModule: deps.wager !== null,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('engine_shutdown', { signal });
    crons.stop();
    supervisor.stopAll();
    proofWorker.stop();
    apiServer?.close();
    if (runner?.isRunning()) await runner.stop();
    await queue.idle().catch(() => undefined);
    queue.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
