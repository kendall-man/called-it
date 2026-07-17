/**
 * Called It engine — the single long-running process:
 * grammY bot (long polling via @grammyjs/runner) + TxLINE ingest supervisor +
 * settlement loop + durable recovery workers + cron ticks. Booting validates the
 * environment with zod and fails loudly on misconfiguration.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { run } from '@grammyjs/runner';
import { TUNABLES } from '@calledit/market-engine';
import { buildWalletLinkMessage, verifyWalletLinkSignature } from '@calledit/solana';
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
import { createOnchainExpectedScoresRootSource } from './proofs/verification.js';
import { Settler } from './settle/settler.js';
import { IngestSupervisor } from './ingest/supervisor.js';
import { startCrons } from './cron/index.js';
import { startEngineApi } from './api/server.js';
import { createTelegramIngressHandler } from './api/telegram-ingress-boundary.js';
import { createPersistAndRoute } from './telegram/persist-and-route.js';
import { createTelegramRoutingPolicy } from './telegram/routing-decision.js';
import { createEngineRuntime } from './runtime.js';
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
import {
  createShutdownSignalHandler,
  runBoundedShutdown,
  type ShutdownDrainPort,
  type ShutdownSignal,
} from './api/shutdown.js';

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
  assertWagerBootable(env, deps.wager !== null);

  const say = createSay(deps.agent, log);
  const webhookIngress = env.TELEGRAM_INGRESS === 'webhook';
  const entities = new EntityCache(deps.db);
  let settler: Settler | null = null;
  const runtime = createEngineRuntime({
    jobs: deps.runtime.settlementJobs,
    proofSubmissionOutbox: deps.runtime.proofOutbox,
    telegram: deps.runtime.telegram,
    facts: deps.runtime.settlementFacts,
    effects: {
      async apply(marketId) {
        if (deps.wager === null) throw new Error('wager_module_unavailable');
        await deps.wager.applySettlement(marketId);
      },
    },
    receipts: {
      async deliver(fact) {
        const market = await deps.db.getMarket(fact.marketId);
        if (market === null || settler === null) return 'pending';
        return settler.deliverDurableReceipt(market, fact.outcome);
      },
    },
    tx: deps.tx,
    proofSubmission: deps.runtime.proofSubmission,
    roots: createOnchainExpectedScoresRootSource({
      rpcUrl: env.SOLANA_RPC_URL,
      programId: env.TXORACLE_PROGRAM_ID,
    }),
    marketEvidence: deps.db,
    poster,
    clock: { now: deps.now },
    policy: {
      maxAttempts: env.QUEUE_MAX_ATTEMPTS,
      leaseMs: env.QUEUE_LEASE_MS,
      retryBaseMs: env.QUEUE_RETRY_BASE_MS,
      retryMaxMs: env.QUEUE_RETRY_MAX_MS,
      initialChainProofDelayMs: ENGINE.PROOF_FIRST_ATTEMPT_DELAY_MS,
      batchSize: 20,
      reconcileLimit: 100,
    },
    log,
    workerId: randomUUID(),
    settlementEnabled: deps.wager !== null,
    ...(webhookIngress
      ? { ingressHandler: createTelegramIngressHandler((update) => bot.handleUpdate(update)) }
      : {}),
  });
  settler = new Settler(deps, poster, say, null, runtime.journal);
  const supervisor = new IngestSupervisor(deps, settler);

  const handlerCtx: HandlerCtx = {
    deps,
    queue,
    poster,
    say,
    supervisor,
    entities,
    budget: new LlmBudget(),
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
    log.warn('set_commands_failed', { error: String(err) });
  });

  const persistAndRoute = createPersistAndRoute({
    analyticsHmacSecretBase64: env.ANALYTICS_HMAC_SECRET,
    db: {
      async persistUpdate(input) {
        const persisted = await deps.runtime.telegram.persistUpdate(input);
        if (!persisted.ok) throw new Error(`telegram_ingress_persist_${persisted.code}`);
        return persisted;
      },
    },
    route: createTelegramRoutingPolicy({
      botUsername: env.TELEGRAM_BOT_USERNAME,
      prefilter: async (text) => deps.agent.prefilter(text, await entities.get()),
      resolveOwnedReply: async (chatId, messageId) => {
        const resolved = await deps.runtime.telegram.resolveOwnedMessage(chatId, messageId);
        return resolved.ok ? resolved.owner : 'unknown';
      },
    }),
  });
  const persistTelegramIngress = createTelegramIngressHandler(async (update) => {
    await persistAndRoute(Object.fromEntries(Object.entries(update)));
    void runtime.tick();
  });
  if (webhookIngress) {
    await bot.init(); // The durable ingress worker dispatches through handleUpdate.
    telegramHeartbeatAtMs = deps.now();
  }
  const crons = startCrons({ deps, poster, say, settler, supervisor, durableRecovery: runtime });
  let runner: ReturnType<typeof run> | null = null;
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
  const readinessPorts: EngineReadinessPorts = {
    ...deps.readiness,
    proof: runtime.readiness.proof,
    settlement: runtime.readiness.settlement,
    telegram: {
      async snapshot() {
        if (webhookIngress) {
          return runtime.readiness.telegram.snapshot(new AbortController().signal);
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
    walletLinkVerifier: {
      build: buildWalletLinkMessage,
      verify: verifyWalletLinkSignature,
    },
    ...(webhookIngress
      ? {
          telegramIngress: {
            accept: persistTelegramIngress,
          },
        }
      : {}),
  });
  // Webhook ingress: the concierge owns getUpdates' replacement (the webhook)
  // and forwards; polling here would 409 against the registered webhook.
  if (webhookIngress) {
    // Updates enter only through the persisted ingress queue in webhook mode.
  } else {
    runner = run(bot);
    telegramHeartbeatAtMs = deps.now();
  }
  log.info('engine_up', {
    webBaseUrl: env.WEB_BASE_URL,
    proofSubmitter: deps.runtime.proofSubmission !== null,
    api: apiServer !== null,
    ingress: env.TELEGRAM_INGRESS,
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
        runtime.stop();
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
      drains: [...deps.drains, ...runtime.shutdownDrains(), queueDrain],
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
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
