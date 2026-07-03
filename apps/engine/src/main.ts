/**
 * Called It engine — the single long-running process:
 * grammY bot (long polling via @grammyjs/runner) + TxLINE ingest supervisor +
 * settlement loop + async proof worker + cron ticks. Booting validates the
 * environment with zod and fails loudly on misconfiguration.
 */

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

async function main(): Promise<void> {
  const log = createLogger({ app: 'calledit-engine' });
  const env = loadEnv();
  const deps = createDeps(env, log);

  const queue = new SendQueue({
    ratePerMinute: ENGINE.SEND_RATE_PER_MINUTE,
    collapseMs: TUNABLES.CARD_EDIT_COLLAPSE_MS,
    onError: (err, context) => log.error('send_failed', { chatId: context.chatId, error: String(err) }),
  });

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  bot.api.config.use(autoRetry());

  const say = createSay(deps.agent, log);
  const poster = createPoster(bot.api, queue, log);
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
  const runner = run(bot);
  log.info('engine_up', {
    webBaseUrl: env.WEB_BASE_URL,
    proofSubmitter: deps.proofSubmitter !== null,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('engine_shutdown', { signal });
    crons.stop();
    supervisor.stopAll();
    proofWorker.stop();
    if (runner.isRunning()) await runner.stop();
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
