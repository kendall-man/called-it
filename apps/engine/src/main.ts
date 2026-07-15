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
import { createDeps, createProductionEscrowRuntime } from './wiring.js';
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
import { withRetryablePollingConflict } from './telegram/polling-retry.js';
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
import { createCustodyIsolatedBackgroundDeps } from './background/escrow-custody.js';
import { createEscrowFinalizedPointsProjection } from './escrow/points-projection.js';
import { createSupabaseEscrowPrivateBridge } from './escrow/private-bridge.js';
import { createEscrowMarketProvisioner } from './escrow/market-provisioning.js';
import { registerEscrowMarketProvisioner } from './pipeline/escrow-market-provisioning.js';
import { composeClaimCard } from './pipeline/render.js';
import { marketStakeKeyboard } from './bot/keyboards.js';
import { createEscrowEventWorkflowScheduler } from './escrow/event-workflow-scheduler.js';
import { createProductionEscrowEventWorkflowPort } from './escrow/event-workflow-runtime.js';
import { EscrowIntegratedSettler } from './background/escrow-settler.js';

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
    const result = await withRetryablePollingConflict(
      method,
      () => previous(method, payload, signal),
      () => log.warn('telegram_polling_overlap'),
    );
    if (method === 'getUpdates') telegramHeartbeatAtMs = deps.now();
    return result;
  });
  assertWagerBootable(env, deps.wager?.kind ?? null);

  const say = createSay(deps.agent, log, env.SOLANA_NETWORK, env.WAGER_CUSTODY_MODE);
  const backgroundDeps = createCustodyIsolatedBackgroundDeps(
    createAllowlistedBackgroundDeps(deps),
  );
  const points = createGroupPointsService({ db: backgroundDeps.db, log });

  const escrowPrivateBridge = env.WAGER_CUSTODY_MODE === 'escrow'
    ? createSupabaseEscrowPrivateBridge({
        supabaseUrl: env.SUPABASE_URL,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
        network: env.SOLANA_NETWORK,
        markets: deps.db,
        clock: deps.now,
      })
    : null;

  const escrowRuntime = env.WAGER_CUSTODY_MODE === 'escrow'
    ? await (async () => {
        if (escrowPrivateBridge === null) throw new TypeError('escrow private bridge unavailable');
        return createProductionEscrowRuntime({
          env,
          log,
          pointsProjection: createEscrowFinalizedPointsProjection({
            privateParticipants: {
              async prepare(marketId) {
                const market = await deps.db.getMarket(marketId);
                if (market === null) throw new Error('escrow points market unavailable');
                if (!env.ESCROW_ALLOWED_GROUP_IDS.includes(market.group_id)) {
                  throw new Error('escrow points market outside rollout');
                }
                return { custodyMode: 'escrow', replay: market.is_replay };
              },
            },
            points,
          }),
          identities: escrowPrivateBridge,
          walletSessions: escrowPrivateBridge,
          projectionSink: {
            async afterFinalizedTransaction(transaction) {
              await escrowPrivateBridge.project(transaction);
              const marketIds = new Set(
                transaction.projections.map((projection) => projection.marketId),
              );
              for (const marketId of marketIds) {
                const marketState = transaction.projections.find((projection) =>
                  projection.marketId === marketId && projection.kind === 'market_state');
                const settlement = transaction.projections.find((projection) =>
                  projection.marketId === marketId && projection.kind === 'settlement');
                const market = await deps.db.getMarket(marketId);
                if (market === null) continue;
                if (marketState?.kind === 'market_state') {
                  await deps.db.updateMarketStatus(marketId, marketState.state);
                }
                if (settlement?.kind === 'settlement') {
                  await deps.db.updateMarketStatus(
                    marketId,
                    settlement.outcome === 'void' ? 'voided' : 'settled',
                  );
                  await deps.db.insertSettlement({
                    market_id: marketId,
                    outcome: settlement.outcome,
                    deciding_seq: null,
                    evidence_seqs: [],
                    tier: market.spec.trustTier,
                  });
                }
                const current = await deps.db.getMarket(marketId);
                if (current === null || current.card_tg_message_id === null) continue;
                const card = await composeClaimCard(deps, current);
                if (card === null || card.messageId === null) continue;
                const keyboard = current.status === 'open' || current.status === 'pending_lineup'
                  ? marketStakeKeyboard(deps, current)
                  : undefined;
                poster.editCard(card.chatId, current.id, card.messageId, card.text, keyboard);
              }
            },
          },
        });
      })()
    : null;

  if (escrowRuntime !== null) {
    registerEscrowMarketProvisioner(deps, createEscrowMarketProvisioner({
      db: deps.db,
      initialize: (input) => escrowRuntime.initialization.initialize(input),
      allowedGroupIds: env.ESCROW_ALLOWED_GROUP_IDS,
      oracleSetEpoch: escrowRuntime.marketPolicy.oracleSetEpoch,
      maximumMarketDurationSeconds: escrowRuntime.marketPolicy.maximumMarketDurationSeconds,
      maximumResolutionDelaySeconds: escrowRuntime.marketPolicy.maximumResolutionDelaySeconds,
      clock: () => {
        const milliseconds = deps.now();
        return {
          unix: BigInt(Math.floor(milliseconds / 1_000)),
          iso: new Date(milliseconds).toISOString(),
        };
      },
    }));
  }

  const escrowScheduler = escrowRuntime === null ? null : createEscrowEventWorkflowScheduler({
    deps,
    allowedGroupIds: env.ESCROW_ALLOWED_GROUP_IDS,
    deployment: {
      genesisHash: env.ESCROW_GENESIS_HASH!,
      programId: env.ESCROW_PROGRAM_ID!,
    },
    oracle: escrowRuntime.oracleAttestations,
    workflow: createProductionEscrowEventWorkflowPort({
      supabaseUrl: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      db: escrowRuntime.db,
      accounts: escrowRuntime.accounts,
      deployment: {
        cluster: env.SOLANA_NETWORK,
        genesisHash: env.ESCROW_GENESIS_HASH!,
        programId: env.ESCROW_PROGRAM_ID!,
        custodyVersion: 1,
      },
      control: escrowRuntime.control,
      recovery: escrowRuntime.recovery,
    }),
    clock: () => BigInt(Math.floor(deps.now() / 1_000)),
  });
  const settler = escrowScheduler === null
    ? new Settler(backgroundDeps, poster, say, points, null)
    : new EscrowIntegratedSettler(backgroundDeps, poster, say, points, null, escrowScheduler);
  const supervisor = new IngestSupervisor(backgroundDeps, settler);
  const settlementReconciler = createSettlementReconciler(backgroundDeps, log);

  const handlerCtx: HandlerCtx = {
    deps, queue, poster, say, supervisor,
    entities: new EntityCache(deps.db), budget: new LlmBudget(),
    ...(escrowRuntime === null ? {} : { escrow: escrowRuntime.telegram }),
  };

  supervisor.onReplayFinished = (groupId, fixtureId) => {
    void (async () => {
      const fixture = await deps.db.getFixture(fixtureId);
      const label = fixture ? `${fixture.p1_name} vs ${fixture.p2_name}` : `fixture ${fixtureId}`;
      poster.post(groupId, await say('replay_finished', { fixture: label }));
    })();
  };
  supervisor.onReplayFailed = (groupId) => {
    void (async () => {
      poster.post(groupId, await say('replay_failed'));
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
  escrowRuntime?.lifecycle.start();
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
    ...(escrowRuntime === null ? {} : { escrowPositions: escrowRuntime.placement }),
    ...(env.WEB_CONCIERGE_TOKEN_SHA256 === undefined
      ? {}
      : { escrowWebTokenSha256: env.WEB_CONCIERGE_TOKEN_SHA256 }),
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
    escrowRuntime: escrowRuntime !== null,
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
        void escrowRuntime?.lifecycle.stop();
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
      drains: [
        ...deps.drains,
        ...(escrowRuntime === null ? [] : [{
          name: 'escrow_workers',
          drain: () => escrowRuntime.lifecycle.stop(),
          unfinished: () => escrowRuntime.lifecycle.unfinished(),
        }]),
        queueDrain,
      ],
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
