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
import { loadEnv } from './env.js';
import { createLogger } from './log.js';
import { createDeps } from './wiring.js';
import { classifySendFailure, createEngineSendQueue } from './bot/send-failure.js';
import { createPoster } from './bot/poster.js';
import { createSay } from './bot/copy.js';
import { EntityCache } from './bot/entities.js';
import { LlmBudget } from './bot/budget.js';
import { BOT_COMMANDS, registerBotHandlers } from './bot/bot.js';
import type { HandlerCtx } from './bot/context.js';
import { Settler } from './settle/settler.js';
import { createGroupPointsService } from './points/service.js';
import { createSettlementReconciler } from './settle/settlement-reconciler.js';
import { IngestSupervisor } from './ingest/supervisor.js';
import { startCrons } from './cron/index.js';
import { startEngineApi } from './api/server.js';
import { createTelegramIngressHandler } from './api/telegram-ingress-boundary.js';
import { assertWagerBootable } from './wager-capability.js';
import {
  createEngineReadinessChecks,
  type EngineReadinessPolicy,
  type EngineReadinessPorts,
} from './api/readiness-checks.js';
import {
  DrainState,
  SYSTEM_READINESS_DEADLINE,
  createReadinessEvaluator,
} from './api/readiness.js';
import { createBetaReadinessPorts } from './api/beta-readiness.js';
import {
  createShutdownSignalHandler,
  runBoundedShutdown,
  type ShutdownDrainPort,
  type ShutdownSignal,
} from './api/shutdown.js';
import { createAllowlistedBackgroundDeps } from './background/allowlisted-db.js';

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

  const queue = createEngineSendQueue(log);

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  bot.api.config.use(autoRetry());
  let telegramHeartbeatAtMs: number | null = null;

  // The poster exists before deps so the wager module can post deposit/
  // withdrawal notifications through the same rate-limited queue.
  const poster = createPoster(bot.api, queue, log);
  const deps = await createDeps(env, log, poster);
  bot.api.config.use(async (previous, method, payload, signal) => {
    const result = await previous(method, payload, signal);
    if (method === 'getUpdates') telegramHeartbeatAtMs = deps.now();
    return result;
  });
  assertWagerBootable(env, deps.wager?.kind ?? null);

  const say = createSay(deps.agent, log);
  const backgroundDeps = createAllowlistedBackgroundDeps(deps);
  const points = createGroupPointsService({ db: backgroundDeps.db, log });
  const settler = new Settler(backgroundDeps, poster, say, points, null);
  const supervisor = new IngestSupervisor(backgroundDeps, settler);
  const settlementReconciler = createSettlementReconciler(backgroundDeps, log);

  const handlerCtx: HandlerCtx = {
    deps, queue, poster, say, supervisor,
    entities: new EntityCache(deps.db), budget: new LlmBudget(),
  };

  supervisor.onReplayFinished = (groupId, fixtureId) => {
    void (async () => {
      const fixture = await deps.db.getFixture(fixtureId);
      const label = fixture ? `${fixture.p1_name} vs ${fixture.p2_name}` : `fixture ${fixtureId}`;
      poster.post(groupId, await say('replay_finished', { fixture: label }));
    })();
  };

  bot.use(async (_context, next) => {
    telegramHeartbeatAtMs = deps.now();
    await next();
  });
  registerBotHandlers(bot, handlerCtx);

  await bot.api.setMyCommands([...BOT_COMMANDS]).catch((err) => {
    log.warn('set_commands_failed', classifySendFailure(err));
  });

  const crons = startCrons({
    deps: backgroundDeps, poster, say, settler, supervisor, settlementReconciler,
  });
  const webhookIngress = env.TELEGRAM_INGRESS === 'webhook';
  let runner: ReturnType<typeof run> | null = null;
  let webhookWorkerReady = false;
  const drainState = new DrainState();
  const readinessPolicy = {
    checkTimeoutMs: env.READINESS_CHECK_TIMEOUT_MS,
    feedMaxAgeMs: env.READINESS_FEED_MAX_AGE_MS,
    ingressMaxAgeMs: env.READINESS_INGRESS_MAX_AGE_MS,
    workerMaxAgeMs: env.READINESS_WORKER_MAX_AGE_MS,
    proofMaxBacklog: env.READINESS_PROOF_MAX_BACKLOG,
    proofMaxOldestAgeMs: env.READINESS_PROOF_MAX_OLDEST_AGE_MS,
    settlementMaxBacklog: env.READINESS_SETTLEMENT_MAX_BACKLOG,
    settlementMaxOldestAgeMs: env.READINESS_SETTLEMENT_MAX_OLDEST_AGE_MS,
  } satisfies EngineReadinessPolicy;
  const betaReadiness = createBetaReadinessPorts({
    base: deps.readiness,
    feed: { snapshot: (signal) => settlementReconciler.feedSnapshot(signal) },
    settlement: { snapshot: (signal) => settlementReconciler.snapshot(signal) },
  });
  const readinessPorts: EngineReadinessPorts = {
    ...betaReadiness,
    telegram: {
      async snapshot() {
        if (webhookIngress) {
          return { heartbeatAtMs: webhookWorkerReady ? deps.now() : null };
        }
        return {
          heartbeatAtMs: runner?.isRunning() ? telegramHeartbeatAtMs : null,
        };
      },
    },
  };
  const readiness = createReadinessEvaluator({
    checks: createEngineReadinessChecks(
      readinessPorts,
      readinessPolicy,
      deps.now,
    ),
    checkTimeoutMs: readinessPolicy.checkTimeoutMs,
    deadline: SYSTEM_READINESS_DEADLINE,
    drainState,
  });
  const apiServer = startEngineApi({
    deps,
    poster,
    env,
    log,
    readiness,
    drainState,
    ...(webhookIngress
      ? {
          telegramIngress: {
            accept: createTelegramIngressHandler((update) => bot.handleUpdate(update)),
          },
        }
      : {}),
  });
  // Webhook ingress: the concierge owns getUpdates' replacement (the webhook)
  // and forwards; polling here would 409 against the registered webhook.
  if (webhookIngress) {
    await bot.init(); // handleUpdate needs botInfo, which run() normally fetches
    webhookWorkerReady = true;
    telegramHeartbeatAtMs = deps.now();
  } else {
    runner = run(bot);
    telegramHeartbeatAtMs = deps.now();
  }
  log.info('engine_up', {
    proofSubmitter: deps.proofSubmitter !== null,
    api: apiServer !== null,
    wagerModule: deps.wager !== null,
  });

  let queueDrained = false;
  const queueDrain = {
    name: 'telegram_send_queue',
    async drain() {
      await queue.idle();
      queueDrained = true;
    },
    unfinished: () => (queueDrained ? 0 : 1),
  } satisfies ShutdownDrainPort;
  const shutdown = async (signal: ShutdownSignal) => {
    log.info('engine_shutdown_started', { signal });
    const result = await runBoundedShutdown({
      timeoutMs: env.SHUTDOWN_DRAIN_TIMEOUT_MS,
      deadline: SYSTEM_READINESS_DEADLINE,
      drainState,
      stopIntake() {
        crons.stop();
        supervisor.stopAll();
      },
      async closeResources(abortSignal) {
        const closeApi = new Promise<void>((resolveClose) => {
          if (!apiServer.listening) {
            resolveClose();
            return;
          }
          apiServer.close(() => resolveClose());
          abortSignal.addEventListener(
            'abort',
            () => {
              apiServer.closeAllConnections();
              resolveClose();
            },
            { once: true },
          );
        });
        const closeRunner = runner?.isRunning() ? runner.stop() : Promise.resolve();
        await Promise.all([closeApi, closeRunner]);
      },
      drains: [...deps.drains, queueDrain],
    });
    queue.stop();
    log.info('engine_shutdown_complete', {
      signal,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      unfinishedCount: result.unfinishedCount,
      unfinished: result.unfinished,
    });
    return result;
  };
  const handleSignal = createShutdownSignalHandler({
    shutdown,
    repeated: (signal) => log.warn('engine_shutdown_repeated_signal', { signal }),
    exit: (code) => process.exit(code),
  });
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
}

main().catch((err: unknown) => {
  createLogger({ app: 'calledit-engine' }).error('engine_start_failed', classifySendFailure(err));
  process.exit(1);
});
