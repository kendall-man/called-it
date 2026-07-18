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
import { createLogger, type Logger } from './log.js';
import { createDeps, createProductionEscrowRuntime } from './wiring.js';
import { classifySendFailure, createEngineSendQueue } from './bot/send-failure.js';
import { classifyEngineStartFailure } from './startup-failure.js';
import { createPoster } from './bot/poster.js';
import { createSay } from './bot/copy.js';
import { EntityCache } from './bot/entities.js';
import { LlmBudget } from './bot/budget.js';
import { BOT_COMMANDS, registerBotHandlers } from './bot/bot.js';
import type { HandlerCtx } from './bot/context.js';
import { UiStateStore } from './bot/stake-ui-state.js';
import { createTelegramEphemeralPort } from './bot/ephemeral.js';
import { STEPPER_CLOSED_LINE } from './bot/stake-step-cards.js';
import { ClaimSurfaceStore } from './pipeline/claim-surface.js';
import { reactToSettledClaim, Settler } from './settle/settler.js';
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
import {
  createEscrowFinalizedPointsProjection,
  createEscrowPrivatePointsParticipants,
} from './escrow/points-projection.js';
import { createSupabaseEscrowPrivateBridge } from './escrow/private-bridge.js';
import {
  createEscrowMarketProvisioner,
  type EscrowMarketProvisioner,
} from './escrow/market-provisioning.js';
import { registerEscrowMarketProvisioner } from './pipeline/escrow-market-provisioning.js';
import { composeClaimCard, receiptUrl } from './pipeline/render.js';
import { marketStakeKeyboard } from './bot/keyboards.js';
import {
  createEscrowProgressObserver,
  createEscrowSignerCompletionDmOutbox,
  enqueueEscrowSignerCompletionDm,
} from './bot/escrow-ux.js';
import { createEscrowEventWorkflowScheduler } from './escrow/event-workflow-scheduler.js';
import { createProductionEscrowEventWorkflowPort } from './escrow/event-workflow-runtime.js';
import { EscrowIntegratedSettler } from './background/escrow-settler.js';
import { createEscrowReadinessHealthCheck } from './escrow/readiness-health.js';

/**
 * Load the repo-root `.env` into process.env for local/dev runs. Production
 * hosts (Railway/Fly) inject env vars directly and ship no file, so a missing
 * `.env` is not an error. Walks up from this module so it resolves whether run
 * from `src` (tsx) or `dist` (node) and regardless of the caller's cwd. Values
 * already present in the environment win, so platform overrides are respected.
 */
/** Mirrors the wager module's parser: a bad value downgrades to "no ops chat". */
function parseOpsChatId(raw: string | undefined, log: Logger): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    log.warn('wager_ops_chat_invalid', { reason: 'not_safe_integer' });
    return null;
  }
  return parsed;
}

function loadDotEnv(): void {
  if (process.env.CALLEDIT_ENV_PRELOADED === 'true') return;
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

  // Signer completion DMs: one per finalized position event, deduped by the
  // event key in-process; the copy tolerates an at-least-once redelivery.
  const escrowCompletionDms = createEscrowSignerCompletionDmOutbox({
    post: (chatId, text) => poster.post(chatId, text),
  });
  const escrowPrivateBridge = env.WAGER_CUSTODY_MODE === 'escrow'
    ? createSupabaseEscrowPrivateBridge({
        supabaseUrl: env.SUPABASE_URL,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
        network: env.SOLANA_NETWORK,
        markets: deps.db,
        clock: deps.now,
        positionEvents: {
          async onFinalizedPositionEvent(event) {
            // 'activated' stays silent: the card's fair-play line covers it,
            // and the signer already got the finalized DM for this lot.
            if (event.eventKind === 'activated') return;
            try {
              await enqueueEscrowSignerCompletionDm(escrowCompletionDms, {
                idempotencyKey:
                  `${event.signature}:${event.lotNonce.toString()}:${event.eventKind}`,
                telegramUserId: event.telegramUserId,
                network: env.SOLANA_NETWORK,
                asset: event.asset,
                amountAtomic: event.amountAtomic,
                side: event.side,
                state: event.eventKind === 'placed' ? 'finalized' : 'recoverable',
                receiptUrl: receiptUrl(deps, event.marketId),
              });
            } catch {
              log.warn('escrow_completion_dm_enqueue_failed');
            }
          },
        },
      })
    : null;

  const escrowProgressObserver = escrowPrivateBridge === null ? null : createEscrowProgressObserver({
    opsChatId: parseOpsChatId(env.WAGER_OPS_CHAT_ID, log),
    post: (chatId, text) => poster.post(chatId, text),
    resolveDeadLetterSigner: (jobId) => escrowPrivateBridge.resolveRelayerJobSigner(jobId),
    now: deps.now,
    log,
  });

  // `legacy` is the pre-enable mode. Once escrow liabilities exist, keep this
  // runtime enabled and roll intake back per group so recovery remains live.
  const escrowRuntime = env.WAGER_CUSTODY_MODE === 'escrow'
    ? await (async () => {
        if (escrowPrivateBridge === null) throw new TypeError('escrow private bridge unavailable');
        return createProductionEscrowRuntime({
          env,
          log,
          pointsProjection: createEscrowFinalizedPointsProjection({
            privateParticipants: createEscrowPrivatePointsParticipants({ markets: deps.db }),
            points,
          }),
          identities: escrowPrivateBridge,
          walletSessions: escrowPrivateBridge,
          ...(escrowProgressObserver === null ? {} : {
            onRelayerResults: (results) =>
              escrowProgressObserver.observeRelayerResults(results),
          }),
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
                  await reactToSettledClaim(deps, poster, market, settlement.outcome);
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

  let escrowProvisioner: EscrowMarketProvisioner | null = null;
  if (escrowRuntime !== null) {
    escrowProvisioner = createEscrowMarketProvisioner({
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
    });
    registerEscrowMarketProvisioner(deps, escrowProvisioner);
  }

  const escrowScheduler = escrowRuntime === null ? null : createEscrowEventWorkflowScheduler({
    deps,
    deployment: {
      genesisHash: env.ESCROW_GENESIS_HASH!,
      programId: env.ESCROW_PROGRAM_ID!,
    },
    requests: escrowRuntime.attestationRequests,
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
    }),
  });
  const settler = escrowScheduler === null
    ? new Settler(backgroundDeps, poster, say, points, null)
    : new EscrowIntegratedSettler(backgroundDeps, poster, say, points, null, escrowScheduler);
  const supervisor = new IngestSupervisor(backgroundDeps, settler, {
    // Escrow event workflows persist their own work as events arrive. At replay
    // EOF, immediately give those durable queues one pass instead of claiming
    // settlement before finalized projection confirms it.
    async scheduleReplayConfirmation() {
      await escrowRuntime?.lifecycle.runOnce();
    },
  });
  const settlementReconciler = createSettlementReconciler(backgroundDeps, log);

  // Bounded escrow readiness snapshot shared by the /status board and the
  // minute-grade ops probe; a slow or failing probe reads as "not ready".
  const probeEscrowReadiness = async (): Promise<{
    readonly status: 'ready' | 'not_ready';
    readonly reasons: readonly string[];
  }> => {
    const unavailable = {
      status: 'not_ready',
      reasons: ['readiness_probe_unavailable'],
    } as const;
    if (escrowRuntime === null) return unavailable;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<typeof unavailable>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(unavailable);
      }, env.READINESS_CHECK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        escrowRuntime.readiness('intake', controller.signal).catch(() => unavailable),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  // Per-user ephemeral stepper surface (STAKE_LADDER_ENABLED). A raw Bot API
  // client for the ephemeral group messages the stepper lives in; built only
  // when the flag is on so a flag-off deploy loads zero of it and stays the
  // single-tap flow, byte-for-byte.
  const ephemeralPort = env.STAKE_LADDER_ENABLED
    ? createTelegramEphemeralPort({ token: env.TELEGRAM_BOT_TOKEN, log })
    : null;

  // Per-user stepper visual store (STAKE_LADDER_ENABLED), keyed by (market,
  // user). onExpire closes a member's ephemeral stepper when they walk away
  // mid-compose (a purely visual timeout — no money depends on it). The SHARED
  // card is never touched, so other members keep their two side buttons.
  const uiStateStore = env.STAKE_LADDER_ENABLED
    ? new UiStateStore({
        onExpire: (_marketId, userId, state) => {
          void (ephemeralPort ?? undefined)
            ?.edit({ userId, ephemeralMessageId: state.ephemeralMessageId, text: STEPPER_CLOSED_LINE })
            .catch(() => log.warn('stake_ui_revert_failed'));
        },
      })
    : null;

  // Single-message claim lifecycle surface store (STAKE_LADDER_ENABLED). Built
  // only when the flag is on so a flag-off deploy keeps today's separate
  // consent-gate / options / card posts, byte-for-byte. In-process only: a
  // restart loses the id of any claim still mid-consent, which then falls back
  // to the fresh-post behavior for its next state.
  const claimSurfaceStore = env.STAKE_LADDER_ENABLED ? new ClaimSurfaceStore() : null;

  const handlerCtx: HandlerCtx = {
    deps, queue, poster, say, supervisor,
    entities: new EntityCache(deps.db), budget: new LlmBudget(),
    ...(escrowRuntime === null ? {} : { escrow: escrowRuntime.telegram }),
    ...(escrowRuntime === null ? {} : { status: { escrowReadiness: probeEscrowReadiness } }),
    ...(uiStateStore === null ? {} : { uiState: uiStateStore }),
    ...(ephemeralPort === null ? {} : { ephemeral: ephemeralPort }),
    ...(claimSurfaceStore === null ? {} : { claimSurface: claimSurfaceStore }),
  };

  supervisor.onReplayConfirmationScheduled = ({ groupId, fixtureId }) => {
    void (async () => {
      const fixture = await deps.db.getFixture(fixtureId);
      const label = fixture ? `${fixture.p1_name} vs ${fixture.p2_name}` : `fixture ${fixtureId}`;
      poster.post(groupId, await say('replay_finished', {
        fixture: label,
        custodyMode: env.WAGER_CUSTODY_MODE,
        network: env.SOLANA_NETWORK,
      }));
    })();
  };
  supervisor.onReplayFailed = (groupId) => {
    void (async () => {
      poster.post(groupId, await say('replay_failed'));
    })();
  };

  // Active replay sources are process-local. Any replay market present after a
  // restart belongs to an old run, so lock it before accepting fresh callbacks.
  await Promise.all(env.ESCROW_ALLOWED_GROUP_IDS.map(async (groupId) => {
    try {
      await supervisor.recoverReplayGroup(groupId);
    } catch {
      log.warn('replay_recovery_failed', { groupId });
    }
  }));

  bot.use(async (_context, next) => {
    telegramHeartbeatAtMs = deps.now();
    await next();
  });
  registerBotHandlers(bot, handlerCtx);

  await bot.api.setMyCommands([...BOT_COMMANDS]).catch((err) => {
    log.warn('set_commands_failed', classifySendFailure(err));
  });

  const provisionerForRecovery = escrowProvisioner;
  const crons = startCrons({
    deps: backgroundDeps, poster, say, settler, supervisor, settlementReconciler,
    ...(provisionerForRecovery === null ? {} : {
      escrowPausedCards: {
        async ready(market) {
          try {
            return await provisionerForRecovery.ensure(market);
          } catch {
            return false;
          }
        },
      },
    }),
    ...(escrowProgressObserver === null ? {} : {
      escrowOps: {
        async tick() {
          escrowProgressObserver.observeEscrowReadiness(await probeEscrowReadiness());
        },
      },
    }),
    ...(claimSurfaceStore === null ? {} : { claimSurface: claimSurfaceStore }),
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
  const escrowReadiness = escrowRuntime === null ? {} : {
    escrow: createEscrowReadinessHealthCheck({
      readiness: (signal) => escrowRuntime.readiness('intake', signal),
      now: deps.now,
      cacheTtlMs: Math.max(
        1_000,
        Math.min(10_000, Math.floor(env.READINESS_WORKER_MAX_AGE_MS / 2)),
      ),
      failureCacheTtlMs: 1_000,
      probeTimeoutMs: env.READINESS_CHECK_TIMEOUT_MS,
      log,
    }),
  };
  const readinessPorts: EngineReadinessPorts = {
    ...betaReadiness,
    ...escrowReadiness,
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
    ...(escrowRuntime === null
      ? {}
      : { escrowPositions: escrowRuntime.placement, escrowSessions: escrowRuntime.telegram }),
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
  createLogger({ app: 'calledit-engine' }).error('engine_start_failed', classifyEngineStartFailure(err));
  process.exit(1);
});
