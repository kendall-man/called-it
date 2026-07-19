/**
 * The ONLY module that imports sibling workspace packages directly.
 * Everything else consumes them through the ports defined in ports.ts, so any
 * drift between CONTRACTS.md and a sibling's real surface is fixed here alone.
 */

import { CLAIM_TYPES, checkDebounce, compileClaim, priceSpec, reduceMarket, type MatchEvent } from '@calledit/market-engine';
import { createEngineDb, createEscrowDb } from '@calledit/db';
import {
  compiledEscrowProgramIdForNetwork,
  deriveMarketPda,
  deriveOracleSetPda,
  deriveProtocolConfigPda,
} from '@calledit/escrow-sdk';
import {
  classifyMessage,
  parseClaim,
  persona,
  PERSONA_TEMPLATE_KEYS,
  prefilter,
  type ParseToolExecutors,
} from '@calledit/agent';
import {
  LiveSource,
  ReplaySource,
  TxlineClient,
  combineOddsSnapshot,
  normalizeScores,
  type TxlineLogger,
} from '@calledit/txline';
import {
  base58Decode,
  bytesToHex,
  Connection,
  loadWallet,
  submitValidateStat,
} from '@calledit/solana';
import type { AgentPort, Deps, EngineDb, EventSourceLike, MarketRow, OddsFetchResult, ProofSubmitter, TxPort } from './ports.js';
import type { WagerModule, WagerPoster } from './wager/module.js';
import type { Env } from './env.js';
import type { Logger } from './log.js';
import { mapFixtureRecord } from './ingest/fixtureMap.js';
import { ENGINE } from './engineConstants.js';
import { bindAbortSignalToFetch } from './api/readiness-http.js';
import { createSupabaseProductionReadinessPorts } from './api/readiness-production.js';
import { resolvePersonaTemplateKey } from './wiring-agent.js';
import { createProductionProofSubmitter } from './wiring-proof.js';
import { createProductionWagerRuntime } from './wiring-wager-runtime.js';
import {
  SolanaEscrowAccountReader,
  SolanaEscrowPlacementChain,
  SolanaEscrowRecoveryChain,
  SolanaMarketInitializationReader,
  SolanaMarketRelayerChain,
} from './escrow/solana-accounts.js';
import { createEscrowSolanaRpc } from './escrow/solana-rpc.js';
import { createEscrowPlacementService } from './escrow/placement-service.js';
import type { EscrowPlacementDeployment } from './escrow/placement-types.js';
import {
  createEscrowRecoveryService,
  type EscrowRecoveryDeployment,
} from './escrow/recovery-workflows.js';
import { createEscrowRecoveryTransactionBuilder } from './escrow/recovery-relayer.js';
import { createEscrowRecoveryFinalityVerifier } from './escrow/recovery-finality.js';
import {
  createEscrowRelayerWorker,
  type EscrowRelayerRunResult,
} from './escrow/relayer-worker.js';
import { EscrowEventProjectionError, SolanaEscrowEventProjector } from './escrow/event-projector.js';
import { SolanaFinalizedEscrowEventSource } from './escrow/solana-finalized-source.js';
import { createFinalizedEscrowIndexer } from './escrow/finalized-indexer.js';
import type { EscrowReadinessReport } from './escrow/readiness.js';
import type { EscrowFinalizedPointsProjection } from './escrow/points-projection.js';
import { PublicKey, type Signer } from '@solana/web3.js';
import {
  createMarketInitializationService,
  type EscrowMarketDeployment,
} from './escrow/market-initializer.js';
import {
  createMarketInitializationFinalityVerifier,
  createMarketInitializationTransactionBuilder,
} from './escrow/market-relayer.js';
import { createEscrowPlacementFinalityVerifier } from './escrow/placement-finality.js';
import { createEscrowReconciler } from './escrow/reconciler.js';
import { SolanaEscrowReconciliationChain } from './escrow/solana-reconciliation.js';
import {
  createEscrowRuntimeLifecycle,
  type EscrowRuntimeLifecycleLog,
} from './escrow/runtime-lifecycle.js';
import type {
  EscrowFinalizedIndexDb,
  EscrowFinalizedScanWatermark,
  EscrowFinalizedTransactionProjection,
} from './escrow/finalized-indexer.js';
import {
  checkEscrowReadiness,
  type EscrowDeploymentExpectation,
} from './escrow/readiness.js';
import {
  createEscrowFinalizedIndexerHealthSource,
  SolanaEscrowReadinessProbe,
} from './escrow/solana-readiness.js';
import {
  createEscrowTelegramPort,
  type EscrowPrivateWalletIdentityProvider,
  type EscrowPrivateWalletSessionProvider,
} from './escrow/telegram-port.js';
import {
  createHttpsEscrowOracleAttestationProvider,
  createLocalEscrowOracleAttestationProvider,
  type EscrowOracleAttestationProvider,
} from './escrow/attestation-signers.js';
import {
  createEscrowControlService,
  type EscrowControlDeployment,
} from './escrow/control-workflows.js';
import {
  createEscrowControlFinalityVerifier,
  createEscrowControlTransactionBuilder,
} from './escrow/control-relayer.js';
import {
  createHttpsEscrowMarketAuthoritySigner,
  createLocalEscrowMarketAuthoritySigner,
  type EscrowMarketAuthoritySignerProvider,
} from './escrow/market-authority-signer.js';
import { createEscrowAttestationRequestService } from './escrow/attestation-request-service.js';
import { createEscrowAttestationRequestWorker } from './escrow/attestation-request-worker.js';
import { createEscrowGroupRolloutService } from './escrow/group-rollout.js';
import { createEscrowSettlementEntitlementScheduler } from './escrow/event-workflow-scheduler.js';
import { createProductionEscrowSettlementPositionPort } from './escrow/event-workflow-runtime.js';
import {
  createEscrowPositionActivationFinalityVerifier,
  createEscrowPositionActivationTransactionBuilder,
} from './escrow/position-activation-relayer.js';
import { createEscrowPositionActivationService } from './escrow/position-activation-service.js';
import { createProductionEscrowPositionActivationScheduler } from './escrow/position-activation-runtime.js';
import { createEscrowTerminalWorkflowOrchestrator } from './escrow/terminal-workflow-orchestrator.js';
import { createEscrowTerminalPositionSource } from './escrow/terminal-workflow-position-source.js';
import { createEscrowPeriodicReconciliationRunner } from './escrow/periodic-reconciliation-runner.js';
import {
  createProductionEscrowReconciliationLinkPort,
} from './escrow/periodic-reconciliation-runtime.js';
import type {
  EscrowPeriodicReconciliationLink,
  EscrowPeriodicReconciliationLog,
} from './escrow/periodic-reconciliation-runner.js';
import { expectedGenesisHash } from './solana-network.js';

// ── Dependency construction ───────────────────────────────────────────────

function requireMarketCustody(value: unknown): MarketRow {
  if (
    value === null || typeof value !== 'object' ||
    ((value as { custody_mode?: unknown }).custody_mode !== 'legacy' &&
      (value as { custody_mode?: unknown }).custody_mode !== 'escrow')
  ) throw new TypeError('market custody mode unavailable');
  return value as MarketRow;
}

export async function createDeps(
  env: Env,
  log: Logger,
  /** Rate-limited chat poster — required only when wager mode is enabled. */
  wagerPoster?: WagerPoster,
): Promise<Deps> {
  const now = () => Date.now();
  const rawDb = createEngineDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const db: EngineDb = {
    ...rawDb,
    setClaimSurfaceMessage: (id, tgMessageId) => rawDb.setClaimSurfaceMessage(id, tgMessageId),
    async insertMarket(input) { return requireMarketCustody(await rawDb.insertMarket(input)); },
    async getMarket(id) {
      const market = await rawDb.getMarket(id);
      return market === null ? null : requireMarketCustody(market);
    },
    async openMarketsForFixture(fixtureId) {
      return (await rawDb.openMarketsForFixture(fixtureId)).map(requireMarketCustody);
    },
    async openMarketsForGroup(groupId) {
      return (await rawDb.openMarketsForGroup(groupId)).map(requireMarketCustody);
    },
  };

  // Grounded tool executors for the parse step — results come from OUR DB,
  // so the model cannot invent entity ids (PRD: LLM proposes, code disposes).
  const parseExecutors: ParseToolExecutors = {
    searchFixtures: async (query) => {
      const rows = await db.searchFixtures(query);
      return rows.map((row) => ({
        fixtureId: row.fixture_id,
        p1Name: row.p1_name,
        p2Name: row.p2_name,
        kickoffMs: row.kickoff_at ? Date.parse(row.kickoff_at) : 0,
        phase: row.phase,
      }));
    },
    resolvePlayer: async (name) => {
      const players = await db.searchPlayers(name);
      return players.map((player) => ({
        normativeId: player.normativeId,
        name: player.name,
        participant: player.participant,
      }));
    },
    getMarketMenu: async () => CLAIM_TYPES.map((claimType) => ({ claimType, mintable: true })),
  };

  const agent: AgentPort = {
    prefilter: (text, entities) => prefilter(text, entities),
    classify: async (text, entities) => {
      const result = await classifyMessage(text, entities);
      return {
        isClaim: result.isClaim,
        confidence: result.confidence,
        claimTypeGuess: result.claimTypeGuess,
      };
    },
    parse: (text, ctx) => parseClaim(text, ctx, { executors: parseExecutors }),
    // No garnish client/budget wired yet → persona returns the deterministic
    // template (garnish is a polish pass; the bot must never block on it).
    persona: (templateKey, vars) =>
      persona(resolvePersonaTemplateKey(PERSONA_TEMPLATE_KEYS, templateKey), vars),
  };

  const txLogger = createTxlineWarningLogger(log);

  const createTxlineClient = (fetchImpl?: typeof fetch): TxlineClient =>
    new TxlineClient({
      apiBase: env.TXLINE_API_BASE,
      guestJwt: env.TXLINE_GUEST_JWT,
      apiToken: env.TXLINE_API_TOKEN,
      logger: txLogger,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  const client = createTxlineClient();

  const fetchOdds = async (
    sourceClient: TxlineClient,
    fixtureId: number,
    asOfMs?: number,
    signal?: AbortSignal,
  ): Promise<OddsFetchResult> => {
    let odds;
    let recordCount = 0;
    try {
      const records = await sourceClient.oddsSnapshot(fixtureId, asOfMs);
      signal?.throwIfAborted();
      recordCount = records.length;
      odds = combineOddsSnapshot(records, { logger: txLogger });
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof Error)) throw error;
      log.warn('odds_snapshot_failed', { fixtureId, reason: dependencyFailureReason(error) });
      return { kind: 'transient' };
    }
    if (!odds) {
      log.info('odds_snapshot_empty', { fixtureId, recordCount });
      return { kind: 'no_odds' };
    }
    return { kind: 'ok', odds };
  };

  const cursorStore = {
    get: (name: string) => db.getCursor(name),
    set: (name: string, id: string) => db.setCursor(name, id),
  };

  const tx: TxPort = {
    fetchOdds: (fixtureId, asOfMs) => fetchOdds(client, fixtureId, asOfMs),
    fetchFixtures: async () => {
      const records = await client.fixturesSnapshot();
      return records.map(mapFixtureRecord);
    },
    fetchScoreEvents: async (fixtureId) => {
      const records = await client.scoresSnapshot(fixtureId);
      return normalizeScores(records, now(), { logger: txLogger });
    },
    fetchStatProof: (fixtureId, seq, statKey) => client.statValidation(fixtureId, seq, statKey),
    createLiveSource: (fixtureId) => {
      // Snapshot gap-fill re-feeds the whole scores snapshot through the same
      // handler; insertFeedEvent's (fixture, seq) key dedupes the overlap.
      let handler: ((event: MatchEvent) => Promise<void>) | null = null;
      const source = new LiveSource({
        client,
        cursorStore,
        fixtureId,
        logger: txLogger,
        gapFill: async (stream) => {
          if (stream !== 'scores' || handler === null) return;
          try {
            const records = await client.scoresSnapshot(fixtureId);
            const receivedAtMs = Date.now();
            for (const record of records) {
              for (const event of normalizeScores(record, receivedAtMs, { logger: txLogger })) {
                await handler(event);
              }
            }
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            log.warn('gap_fill_failed', { fixtureId, reason: dependencyFailureReason(error) });
          }
        },
      });
      const wrapped: EventSourceLike = {
        start(onEvent) {
          handler = onEvent;
          source.start(onEvent);
        },
        stop() {
          source.stop();
        },
      };
      return wrapped;
    },
    createReplaySource: (fixtureId, speed) =>
      new ReplaySource({ client, fixtureId, speed, logger: txLogger }),
  };

  const wager: WagerModule | null = await createProductionWagerRuntime(
    { env, log, engineDb: db, poster: wagerPoster },
    {
      loadStarterOnlyDbFactory: async () =>
        (await import('@calledit/db/wager-starter')).createStarterOnlyWagerDb,
      loadFundedDbFactory: async () =>
        (await import('@calledit/db/wager-funded')).createWagerDb,
      loadFundedSolanaRuntime: async () => {
        const [wagerSolana, wagerRuntime] = await Promise.all([
          import('@calledit/solana'),
          import('./wiring-wager-solana.js'),
        ]);
        return wagerRuntime.createWagerSolanaRuntime(wagerSolana);
      },
    },
  );
  const proofSubmitter: ProofSubmitter | null = createProductionProofSubmitter(env, log, {
    createConnection: (rpcUrl) => new Connection(rpcUrl, 'confirmed'),
    loadWallet,
    submit: (input) => submitValidateStat(input),
  });
  const readiness = createSupabaseProductionReadinessPorts({
    supabaseUrl: env.SUPABASE_URL,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    odds: {
      async snapshot(fixtureId, signal) {
        const request = bindAbortSignalToFetch(globalThis.fetch, signal);
        const result = await fetchOdds(
          createTxlineClient(request),
          fixtureId,
          undefined,
          signal,
        );
        signal.throwIfAborted();
        return result.kind === 'ok'
          ? { kind: 'ok', oddsTsMs: result.odds.oddsTsMs }
          : { kind: 'unavailable' };
      },
    },
    liveLookaheadMs: ENGINE.LIVE_LOOKAHEAD_MS,
    now,
    wagerRuntimeMode: env.WAGER_RUNTIME_MODE,
    wagerModuleKind: wager?.kind ?? null,
    initialSolvencyCheck: wager?.kind === 'funded'
      ? () => wager.ensureInitialSolvencyCheck()
      : undefined,
    starterGrantsEnabled: env.STARTER_GRANTS_ENABLED,
    starterIntakeEnabled: env.STARTER_GRANTS_ENABLED && env.STAKE_ACCEPTANCE_ENABLED,
    proofEnabled: proofSubmitter !== null,
    settlementEnabled: false,
  });

  return {
    db,
    agent,
    engine: { compileClaim, priceSpec, reduceMarket, checkDebounce },
    tx,
    proofSubmitter,
    wager,
    readiness,
    drains: [],
    env,
    log,
    now,
  };
}

type EscrowWave4DeploymentConsistency = {
  readonly marketDeployment: EscrowMarketDeployment;
  readonly placementDeployment: EscrowPlacementDeployment;
  readonly recoveryDeployment: EscrowRecoveryDeployment;
  readonly controlDeployment: EscrowControlDeployment;
  readonly sponsorAddress: string;
  readonly marketCreationAuthorityAddress: string;
  readonly feedOperatorAddress: string;
};

export function assertEscrowWave4DeploymentConsistency(
  options: EscrowWave4DeploymentConsistency,
): void {
  const { marketDeployment, placementDeployment, recoveryDeployment, controlDeployment } = options;
  if (
    marketDeployment.programId !== placementDeployment.programId ||
    placementDeployment.programId !== recoveryDeployment.programId ||
    recoveryDeployment.programId !== controlDeployment.programId ||
    marketDeployment.cluster !== placementDeployment.cluster ||
    placementDeployment.cluster !== recoveryDeployment.cluster ||
    recoveryDeployment.cluster !== controlDeployment.cluster ||
    marketDeployment.genesisHash !== placementDeployment.genesisHash ||
    placementDeployment.genesisHash !== recoveryDeployment.genesisHash ||
    recoveryDeployment.genesisHash !== controlDeployment.genesisHash ||
    marketDeployment.canonicalUsdcMint !== placementDeployment.canonicalUsdcMint ||
    placementDeployment.canonicalUsdcMint !== recoveryDeployment.canonicalUsdcMint ||
    marketDeployment.relayerFeePayer !== options.sponsorAddress ||
    recoveryDeployment.relayerFeePayer !== options.sponsorAddress ||
    marketDeployment.marketCreationAuthority !== options.marketCreationAuthorityAddress ||
    controlDeployment.feedOperatorAuthority !== options.feedOperatorAddress ||
    options.feedOperatorAddress === options.sponsorAddress
  ) throw new TypeError('escrow Wave 4 deployment identity mismatch');
}

export function createEscrowWave4Runtime(options: {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly rpcUrl: string;
  readonly sponsor: Signer;
  readonly marketCreationAuthority: EscrowMarketAuthoritySignerProvider;
  readonly feedOperator: Signer;
  readonly oracleAttestations: EscrowOracleAttestationProvider;
  readonly marketDeployment: EscrowMarketDeployment;
  readonly placementDeployment: EscrowPlacementDeployment;
  readonly recoveryDeployment: EscrowRecoveryDeployment;
  readonly controlDeployment: EscrowControlDeployment;
  readonly intakeReadiness: () => Promise<EscrowReadinessReport>;
  readonly recoveryReadiness: () => Promise<EscrowReadinessReport>;
  readonly clock: () => { readonly unix: bigint; readonly iso: string };
  readonly workerId: string;
  readonly retryAt: (nowIso: string) => string;
  readonly pointsProjection: EscrowFinalizedPointsProjection;
  readonly projectionSink: {
    afterFinalizedTransaction(transaction: EscrowFinalizedTransactionProjection): Promise<void>;
  };
  /** Presentation-only tap on each relayer cycle's otherwise-discarded results. */
  readonly onRelayerResults?: (results: readonly EscrowRelayerRunResult[]) => void;
  /** Fail-closed replay-run gate evaluated before periodic chain reads. */
  readonly admitPeriodicReconciliationLink?: (
    link: EscrowPeriodicReconciliationLink,
  ) => Promise<boolean>;
  readonly worker: {
    readonly intervalMs: number;
    readonly relayerLimit: number;
    readonly attestationLimit: number;
    readonly attestationLeaseMs: number;
    readonly indexerLimit: number;
    readonly log: EscrowRuntimeLifecycleLog & EscrowPeriodicReconciliationLog;
  };
  /** A Surfpool fork shares devnet genesis but must not overwrite the remote cursor. */
  readonly localForkIndexer?: boolean;
}) {
  assertEscrowWave4DeploymentConsistency({
    marketDeployment: options.marketDeployment,
    placementDeployment: options.placementDeployment,
    recoveryDeployment: options.recoveryDeployment,
    controlDeployment: options.controlDeployment,
    sponsorAddress: options.sponsor.publicKey.toBase58(),
    marketCreationAuthorityAddress: options.marketCreationAuthority.authorityAddress,
    feedOperatorAddress: options.feedOperator.publicKey.toBase58(),
  });
  const db = createEscrowDb(options.supabaseUrl, options.serviceRoleKey);
  const rpc = createEscrowSolanaRpc(options.rpcUrl);
  const indexerDb = options.localForkIndexer === true
    ? createForkFinalizedIndexDb(db, async () => BigInt(await rpc.connection.getSlot('finalized')))
    : db;
  const accounts = new SolanaEscrowAccountReader(rpc.connection);
  const placementChain = new SolanaEscrowPlacementChain(rpc, accounts);
  const recoveryChain = new SolanaEscrowRecoveryChain(rpc, accounts);
  const initializationReader = new SolanaMarketInitializationReader(accounts);
  const marketRelayerChain = new SolanaMarketRelayerChain(rpc, accounts);
  const initialization = createMarketInitializationService({
    db, deployment: options.marketDeployment, chain: initializationReader,
    readiness: options.intakeReadiness,
  });
  const placement = createEscrowPlacementService({
    db, sponsor: options.sponsor, deployment: options.placementDeployment,
    chain: placementChain, readiness: options.intakeReadiness, clock: options.clock,
  });
  const recovery = createEscrowRecoveryService({
    db, deployment: options.recoveryDeployment,
    readiness: options.recoveryReadiness, clock: () => options.clock().iso,
  });
  const control = createEscrowControlService({
    db, deployment: options.controlDeployment,
    readiness: options.recoveryReadiness, clock: () => options.clock().iso,
  });
  const attestationRequests = createEscrowAttestationRequestService({
    db,
    deployment: {
      cluster: options.recoveryDeployment.cluster,
      genesisHash: options.recoveryDeployment.genesisHash,
      programId: options.recoveryDeployment.programId,
      custodyVersion: options.recoveryDeployment.custodyVersion,
    },
    maxAttempts: 12,
    leaseMs: options.worker.attestationLeaseMs,
    clock: () => options.clock().iso,
  });
  const attestationWorker = createEscrowAttestationRequestWorker({
    db,
    oracle: options.oracleAttestations,
    control,
    recovery,
    workerId: `${options.workerId}:attestations`,
    retryAt: options.retryAt,
    nextCheckAt: options.retryAt,
  });
  const groupRollouts = createEscrowGroupRolloutService({
    db,
    deployment: {
      cluster: options.marketDeployment.cluster,
      genesisHash: options.marketDeployment.genesisHash,
      programId: options.marketDeployment.programId,
      custodyVersion: options.marketDeployment.custodyVersion,
    },
    clock: () => options.clock().iso,
  });
  const controlBuilder = createEscrowControlTransactionBuilder({
    db, chain: recoveryChain, sponsor: options.sponsor,
    feedOperator: options.feedOperator, deployment: options.controlDeployment,
  });
  const controlFinality = createEscrowControlFinalityVerifier({
    chain: recoveryChain, programId: options.controlDeployment.programId,
  });
  const recoveryBuilder = createEscrowRecoveryTransactionBuilder({
    db, chain: recoveryChain, sponsor: options.sponsor, deployment: options.recoveryDeployment,
  });
  const activationDeployment = {
    cluster: options.recoveryDeployment.cluster,
    genesisHash: options.recoveryDeployment.genesisHash,
    programId: options.recoveryDeployment.programId,
    custodyVersion: options.recoveryDeployment.custodyVersion,
    relayerFeePayer: options.recoveryDeployment.relayerFeePayer,
  } as const;
  const activation = createEscrowPositionActivationService({
    db, chain: recoveryChain, deployment: activationDeployment,
    readiness: options.recoveryReadiness, clock: () => options.clock().iso,
  });
  const activationBuilder = createEscrowPositionActivationTransactionBuilder({
    db, chain: recoveryChain, sponsor: options.sponsor, deployment: activationDeployment,
  });
  const activationFinality = createEscrowPositionActivationFinalityVerifier({
    chain: recoveryChain, deployment: activationDeployment,
  });
  const entitlements = createEscrowSettlementEntitlementScheduler({
    recovery,
    positions: createProductionEscrowSettlementPositionPort({
      supabaseUrl: options.supabaseUrl,
      serviceRoleKey: options.serviceRoleKey,
      accounts,
      programId: options.recoveryDeployment.programId,
    }),
  });
  const finality = createEscrowRecoveryFinalityVerifier({
    chain: recoveryChain, programId: options.recoveryDeployment.programId, entitlements,
  });
  const marketExpectation = {
    cluster: options.marketDeployment.cluster,
    genesisHash: options.marketDeployment.genesisHash,
    programId: options.marketDeployment.programId,
    protocolConfigPda: deriveProtocolConfigPda(options.marketDeployment.programId).address,
    oracleSetPda: deriveOracleSetPda(
      options.marketDeployment.programId,
      options.marketDeployment.oracleSetEpoch,
    ).address,
    oracleSetEpoch: options.marketDeployment.oracleSetEpoch,
    canonicalUsdcMint: options.marketDeployment.canonicalUsdcMint,
    marketCreationAuthority: options.marketDeployment.marketCreationAuthority,
    relayerFeePayer: options.marketDeployment.relayerFeePayer,
  };
  const marketBuilder = createMarketInitializationTransactionBuilder({
    chain: marketRelayerChain,
    sponsor: options.sponsor,
    marketCreationAuthority: options.marketCreationAuthority,
    expected: marketExpectation,
  });
  const marketFinality = createMarketInitializationFinalityVerifier({
    chain: initializationReader,
    expected: marketExpectation,
  });
  const placementFinality = createEscrowPlacementFinalityVerifier({ chain: accounts });
  const recoveryKinds = [
    'settlement_submission', 'timeout_monitoring', 'auto_claim', 'account_close',
  ] as const;
  const builders = {
    ...Object.fromEntries(recoveryKinds.map((kind) => [kind, recoveryBuilder])),
    freeze: controlBuilder,
    unfreeze: controlBuilder,
    position_invalidation: controlBuilder,
    position_activation: activationBuilder,
    market_initialization: marketBuilder,
  };
  const finalityVerifiers = {
    ...Object.fromEntries(recoveryKinds.map((kind) => [kind, finality])),
    freeze: controlFinality,
    unfreeze: controlFinality,
    position_invalidation: controlFinality,
    position_activation: activationFinality,
    market_initialization: marketFinality,
    position_placement: placementFinality,
  };
  const relayer = createEscrowRelayerWorker({
    db, chain: rpc, workerId: options.workerId, retryAt: options.retryAt,
    positionPlacementReadiness: options.intakeReadiness,
    builders, finalityVerifiers,
  });
  const projector = new SolanaEscrowEventProjector(accounts, {
    getMarketLink: (input) => db.getMarketLink(input),
    async hasMarket(marketId) {
      const response = await fetch(
        `${options.supabaseUrl}/rest/v1/markets?id=eq.${encodeURIComponent(marketId)}&select=id&limit=1`,
        {
          headers: {
            apikey: options.serviceRoleKey,
            authorization: `Bearer ${options.serviceRoleKey}`,
          },
        },
      );
      if (!response.ok) throw new EscrowEventProjectionError('history_unavailable');
      const rows: unknown = await response.json();
      if (!Array.isArray(rows)) throw new EscrowEventProjectionError('history_unavailable');
      return rows.length > 0;
    },
  }, {
    cluster: options.recoveryDeployment.cluster,
    genesisHash: options.recoveryDeployment.genesisHash,
    programId: options.recoveryDeployment.programId,
    canonicalUsdcMint: options.recoveryDeployment.canonicalUsdcMint,
    custodyVersion: options.recoveryDeployment.custodyVersion,
  });
  const source = new SolanaFinalizedEscrowEventSource(rpc.connection, {
    genesisHash: options.recoveryDeployment.genesisHash,
    programId: options.recoveryDeployment.programId,
  }, projector);
  const reconciliationChain = new SolanaEscrowReconciliationChain(rpc.connection, {
    programId: options.recoveryDeployment.programId,
    canonicalUsdcMint: options.recoveryDeployment.canonicalUsdcMint,
  });
  const reconciler = createEscrowReconciler({
    db,
    chain: reconciliationChain,
    expected: {
      cluster: options.recoveryDeployment.cluster,
      programId: options.recoveryDeployment.programId,
      canonicalUsdcMint: options.recoveryDeployment.canonicalUsdcMint,
      custodyVersion: options.recoveryDeployment.custodyVersion,
    },
    clock: () => options.clock().iso,
  });
  const activationScheduler = createProductionEscrowPositionActivationScheduler({
    supabaseUrl: options.supabaseUrl,
    serviceRoleKey: options.serviceRoleKey,
    activation,
  });
  const terminal = createEscrowTerminalWorkflowOrchestrator({
    programId: options.recoveryDeployment.programId,
    chain: recoveryChain,
    positions: createEscrowTerminalPositionSource({
      supabaseUrl: options.supabaseUrl,
      serviceRoleKey: options.serviceRoleKey,
    }),
    recovery,
    nowEpochSeconds: () => options.clock().unix,
  });
  const periodicReconciliation = createEscrowPeriodicReconciliationRunner({
    links: createProductionEscrowReconciliationLinkPort({
      db,
      deployment: {
        cluster: options.recoveryDeployment.cluster,
        genesisHash: options.recoveryDeployment.genesisHash,
        programId: options.recoveryDeployment.programId,
        custodyVersion: options.recoveryDeployment.custodyVersion,
      },
    }),
    ...(options.admitPeriodicReconciliationLink === undefined
      ? {}
      : { admitLink: options.admitPeriodicReconciliationLink }),
    reconciler: {
      async reconcile(link) {
        const result = await reconciler.reconcile(link);
        if (result.status === 'in_sync') {
          await activationScheduler.schedulePending(link);
          await terminal.progress(link);
        }
        return result;
      },
    },
    batchSize: options.worker.indexerLimit,
    intervalMs: options.worker.intervalMs,
    log: options.worker.log,
  });
  const indexer = createFinalizedEscrowIndexer({
    db: indexerDb, source,
    expected: {
      cluster: options.recoveryDeployment.cluster,
      genesisHash: options.recoveryDeployment.genesisHash,
      programId: options.recoveryDeployment.programId,
    },
    clock: () => options.clock().iso,
    points: options.pointsProjection,
    allowSlotOnlyCursor: options.localForkIndexer === true,
    async afterTransaction(transaction) {
      await options.projectionSink.afterFinalizedTransaction(transaction);
    },
  });
  const lifecycle = createEscrowRuntimeLifecycle({
    attestations: attestationWorker,
    relayer,
    indexer,
    reconciliation: periodicReconciliation,
    ...(options.onRelayerResults === undefined
      ? {}
      : { onRelayerResults: options.onRelayerResults }),
    clock: () => options.clock().iso,
    intervalMs: options.worker.intervalMs,
    relayerLimit: options.worker.relayerLimit,
    attestationLimit: options.worker.attestationLimit,
    indexerLimit: options.worker.indexerLimit,
    log: options.worker.log,
  });
  return {
    db, rpc, accounts, initialization, placement, control, recovery, recoveryBuilder,
    activation, activationScheduler, terminal, periodicReconciliation,
    groupRollouts, attestationRequests, attestationWorker, relayer, indexer, reconciler, lifecycle,
  };
}

/**
 * Surfpool devnet forks have the real devnet genesis hash but a lower, private
 * slot history. Reusing Supabase's devnet cursor would make every local scan
 * regress. Keep only the cursor in process while retaining durable event and
 * market-link projections for the local test run.
 */
function createForkFinalizedIndexDb(
  db: ReturnType<typeof createEscrowDb>,
  readInitialSlot: () => Promise<bigint>,
): EscrowFinalizedIndexDb {
  let initialSlot: bigint | null = null;
  let cursor: {
    readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
    readonly genesisHash: string;
    readonly programId: string;
    readonly slot: bigint;
    readonly signature: string | null;
    readonly updatedAtIso: string;
  } | null = null;
  return {
    upsertMarketLink: (input) => db.upsertMarketLink(input),
    recordPositionEvent: (input) => db.recordPositionEvent(input),
    recordSettlementEvent: (input) => db.recordSettlementEvent(input),
    recordClaimEvent: (input) => db.recordClaimEvent(input),
    recordMarketClosed: (input) => db.recordMarketClosed(input),
    async getChainCursor(input) {
      initialSlot ??= await readInitialSlot();
      const current = cursor;
      const initialized = current === null || (current.cluster === input.cluster &&
        current.genesisHash === input.genesisHash && current.programId === input.programId);
      return {
        ok: true as const,
        initialized,
        cluster: input.cluster,
        genesisHash: input.genesisHash,
        programId: input.programId,
        confirmedSlot: current?.slot ?? initialSlot,
        confirmedSignature: current?.signature ?? null,
        finalizedSlot: current?.slot ?? initialSlot,
        finalizedSignature: current?.signature ?? null,
        updatedAtIso: current?.updatedAtIso ?? null,
      };
    },
    async advanceChainCursor(input) {
      cursor = {
        cluster: input.cluster,
        genesisHash: input.genesisHash,
        programId: input.programId,
        slot: input.slot,
        signature: input.signature,
        updatedAtIso: input.nowIso,
      };
      return { ok: true as const, duplicate: false, finalized: true };
    },
  };
}

export class EscrowProductionContractError extends Error {
  readonly name = 'EscrowProductionContractError';
  constructor(readonly code: 'configuration_incomplete' | 'deployment_identity_mismatch' | 'market_authority_signer_unavailable') {
    super(`escrow production runtime unavailable: ${code}`);
  }
}

export function assertEscrowConfiguredDeploymentIdentity(options: {
  readonly network: Env['SOLANA_NETWORK'];
  readonly programId: string;
  readonly genesisHash: string;
}): void {
  const compiledProgramId = compiledEscrowProgramIdForNetwork(options.network);
  if (
    compiledProgramId === null ||
    options.programId !== compiledProgramId ||
    options.genesisHash !== expectedGenesisHash(options.network)
  ) throw new EscrowProductionContractError('deployment_identity_mismatch');
}

function requiredEscrowValue<T>(value: T | undefined): T {
  if (value === undefined) throw new EscrowProductionContractError('configuration_incomplete');
  return value;
}

async function upgradeAuthority(connection: Connection, programId: string): Promise<string | null> {
  const program = await connection.getAccountInfo(new PublicKey(programId), 'finalized');
  if (program === null || program.data.length < 36 || program.data.readUInt32LE(0) !== 2) return null;
  const programDataAddress = new PublicKey(program.data.subarray(4, 36));
  const programData = await connection.getAccountInfo(programDataAddress, 'finalized');
  if (programData === null || programData.data.length < 13 || programData.data.readUInt32LE(0) !== 3) return null;
  const authorityPresent = programData.data[12];
  if (authorityPresent === 0) return null;
  if (authorityPresent !== 1 || programData.data.length < 45) return null;
  return new PublicKey(programData.data.subarray(13, 45)).toBase58();
}

export async function createProductionEscrowRuntime(options: {
  readonly env: Env;
  readonly log: Logger;
  readonly pointsProjection: EscrowFinalizedPointsProjection;
  readonly projectionSink: {
    afterFinalizedTransaction(transaction: EscrowFinalizedTransactionProjection): Promise<void>;
  };
  /** Presentation-only tap on each relayer cycle's otherwise-discarded results. */
  readonly onRelayerResults?: (results: readonly EscrowRelayerRunResult[]) => void;
  /** Fail-closed replay-run gate evaluated before periodic chain reads. */
  readonly admitPeriodicReconciliationLink?: (
    link: EscrowPeriodicReconciliationLink,
  ) => Promise<boolean>;
  readonly identities: EscrowPrivateWalletIdentityProvider;
  readonly walletSessions: EscrowPrivateWalletSessionProvider;
  readonly oracleAttestationProvider?: EscrowOracleAttestationProvider;
}) {
  const { env } = options;
  if (env.WAGER_CUSTODY_MODE !== 'escrow') {
    throw new EscrowProductionContractError('configuration_incomplete');
  }
  const programId = requiredEscrowValue(env.ESCROW_PROGRAM_ID);
  const genesisHash = requiredEscrowValue(env.ESCROW_GENESIS_HASH);
  const canonicalUsdcMint = requiredEscrowValue(env.ESCROW_CANONICAL_USDC_MINT);
  const classicTokenProgramId = requiredEscrowValue(env.ESCROW_CLASSIC_TOKEN_PROGRAM_ID);
  const oracleSetPda = requiredEscrowValue(env.ESCROW_ORACLE_SET_PDA);
  const oracleSetEpoch = requiredEscrowValue(env.ESCROW_ORACLE_SET_EPOCH);
  const oracleThreshold = requiredEscrowValue(env.ESCROW_ORACLE_THRESHOLD);
  const indexerMaxLagSlots = requiredEscrowValue(env.ESCROW_INDEXER_MAX_LAG_SLOTS);
  const configAuthority = requiredEscrowValue(env.ESCROW_CONFIG_AUTHORITY);
  const pauseAuthority = requiredEscrowValue(env.ESCROW_PAUSE_AUTHORITY);
  const marketCreationAuthority = requiredEscrowValue(env.ESCROW_MARKET_CREATION_AUTHORITY);
  const configuredUpgradeAuthority = requiredEscrowValue(env.ESCROW_UPGRADE_AUTHORITY);
  const residualRecipient = requiredEscrowValue(env.ESCROW_RESIDUAL_RECIPIENT);
  assertEscrowConfiguredDeploymentIdentity({ network: env.SOLANA_NETWORK, programId, genesisHash });
  const sponsor = loadWallet(requiredEscrowValue(env.ESCROW_RELAYER_KEYPAIR_B58));
  const feedOperator = loadWallet(requiredEscrowValue(env.ESCROW_FEED_OPERATOR_KEYPAIR_B58));
  const marketAuthorityDeployment = {
    network: env.SOLANA_NETWORK,
    genesisHash,
    programId,
    protocolConfigPda: deriveProtocolConfigPda(programId).address,
    oracleSetPda,
    oracleSetEpoch,
  } as const;
  const forbiddenMarketAuthoritySigners = [
    sponsor.publicKey.toBase58(), feedOperator.publicKey.toBase58(), configAuthority,
    ...env.ESCROW_ORACLE_SIGNERS,
  ];
  const marketCreationAuthoritySigner = env.ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON === undefined
    ? createLocalEscrowMarketAuthoritySigner({
        deployment: marketAuthorityDeployment,
        expectedAuthority: marketCreationAuthority,
        signer: loadWallet(requiredEscrowValue(env.ESCROW_MARKET_AUTHORITY_KEYPAIR_B58)),
        forbiddenSignerAddresses: forbiddenMarketAuthoritySigners,
      })
    : createHttpsEscrowMarketAuthoritySigner({
        deployment: marketAuthorityDeployment,
        expectedAuthority: marketCreationAuthority,
        endpoint: env.ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON,
        forbiddenSignerAddresses: forbiddenMarketAuthoritySigners,
        forbiddenEndpointOrigins: env.ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON.map(
          (endpoint) => new URL(endpoint.url).origin,
        ),
      });

  const bootstrapRpc = createEscrowSolanaRpc(env.SOLANA_RPC_URL);
  const bootstrapAccounts = new SolanaEscrowAccountReader(bootstrapRpc.connection);
  const configPda = deriveProtocolConfigPda(programId).address;
  const [observedGenesis, config, oracle] = await Promise.all([
    bootstrapRpc.genesisHash(),
    bootstrapAccounts.config(configPda),
    bootstrapAccounts.oracleSet(oracleSetPda),
  ]);
  const genesisBytes = base58Decode(genesisHash);
  if (
    genesisBytes.length !== 32 || observedGenesis !== genesisHash || config === null || oracle === null ||
    config.ownerProgramId !== programId || oracle.ownerProgramId !== programId ||
    bytesToHex(config.value.clusterGenesisHash) !== bytesToHex(genesisBytes) ||
    config.value.canonicalUsdcMint !== canonicalUsdcMint || config.value.allowedTokenProgram !== classicTokenProgramId ||
    config.value.oracleSet !== oracleSetPda || oracle.value.epoch !== oracleSetEpoch ||
    oracle.value.signatureThreshold !== oracleThreshold ||
    new Set(oracle.value.signers).size !== env.ESCROW_ORACLE_SIGNERS.length ||
    !env.ESCROW_ORACLE_SIGNERS.every((signer) => oracle.value.signers.includes(signer)) ||
    config.value.configAuthority !== configAuthority || config.value.pauseAuthority !== pauseAuthority ||
    config.value.marketCreationAuthority !== marketCreationAuthority ||
    config.value.feedOperatorAuthority !== feedOperator.publicKey.toBase58() ||
    config.value.relayerFeePayer !== sponsor.publicKey.toBase58() ||
    config.value.residualRecipient !== residualRecipient ||
    feedOperator.publicKey.equals(sponsor.publicKey) ||
    feedOperator.publicKey.toBase58() === configAuthority ||
    env.ESCROW_ORACLE_SIGNERS.includes(feedOperator.publicKey.toBase58())
  ) throw new EscrowProductionContractError('deployment_identity_mismatch');

  const oracleAttestations = options.oracleAttestationProvider ?? (
    env.ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON.length > 0
      ? createHttpsEscrowOracleAttestationProvider({
          endpoints: env.ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON.map((endpoint, index) => ({
            ...endpoint,
            expectedSigner: env.ESCROW_ORACLE_SIGNERS[index]!,
          })),
          threshold: oracleThreshold,
          forbiddenSignerAddresses: [configAuthority, sponsor.publicKey.toBase58()],
        })
      : createLocalEscrowOracleAttestationProvider({
          network: env.SOLANA_NETWORK,
          authorizedSignerAddresses: env.ESCROW_ORACLE_SIGNERS,
          signers: env.ESCROW_ORACLE_LOCAL_KEYPAIRS_B58_JSON.map((value) => loadWallet(value)),
          threshold: oracleThreshold,
          forbiddenSignerAddresses: [configAuthority, sponsor.publicKey.toBase58()],
        })
  );

  const expectation: EscrowDeploymentExpectation = {
    network: env.SOLANA_NETWORK,
    genesisHash,
    programId,
    canonicalUsdcMint,
    classicTokenProgramId,
    oracleSetPda,
    oracleSetEpoch,
    oracleThreshold,
    oracleSigners: env.ESCROW_ORACLE_SIGNERS,
    indexerMaxLagSlots,
    authorities: {
      configAuthority,
      pauseAuthority,
      marketCreationAuthority,
      upgradeAuthority: configuredUpgradeAuthority,
    },
  };
  let runtimeIndexer: {
    scanWatermark(): EscrowFinalizedScanWatermark | null;
  } | null = null;
  const indexerHealth = createEscrowFinalizedIndexerHealthSource({
    watermark: {
      scanWatermark: () => runtimeIndexer?.scanWatermark() ?? null,
    },
    async finalizedSlot(signal) {
      signal.throwIfAborted();
      const slot = await bootstrapRpc.connection.getSlot('finalized');
      signal.throwIfAborted();
      return BigInt(slot);
    },
    now: Date.now,
    maxScanAgeMs: env.READINESS_WORKER_MAX_AGE_MS,
  });
  const readinessProbe = new SolanaEscrowReadinessProbe(
    bootstrapRpc.connection,
    bootstrapAccounts,
    expectation,
    indexerHealth,
    {
      availableSigner: (signal) => marketCreationAuthoritySigner.availableSigner(signal),
    },
    {
      availableSigners: () => oracleAttestations.availableSigners(),
    },
    {
      read: (value) => upgradeAuthority(bootstrapRpc.connection, value),
    },
  );
  const readiness = (
    mode: 'intake' | 'recovery',
    signal: AbortSignal = new AbortController().signal,
  ) => checkEscrowReadiness({
    expected: expectation,
    probe: readinessProbe,
    signal,
    mode,
  });
  const clock = () => {
    const milliseconds = Date.now();
    return {
      unix: BigInt(Math.floor(milliseconds / 1_000)),
      iso: new Date(milliseconds).toISOString(),
    };
  };
  const marketDeployment: EscrowMarketDeployment = {
    cluster: env.SOLANA_NETWORK,
    genesisHash,
    programId,
    canonicalUsdcMint,
    marketCreationAuthority,
    relayerFeePayer: sponsor.publicKey.toBase58(),
    oracleSetEpoch,
    custodyVersion: 1,
  };
  const placementDeployment: EscrowPlacementDeployment = {
    cluster: env.SOLANA_NETWORK,
    genesisHash,
    programId,
    canonicalUsdcMint,
    oracleSetEpoch,
    custodyVersion: 1,
    minimumSolPosition: config.value.minimumSolPosition,
    maximumSolPosition: config.value.maximumSolPosition,
    minimumUsdcPosition: config.value.minimumUsdcPosition,
    maximumUsdcPosition: config.value.maximumUsdcPosition,
    allowedGroupIds: env.ESCROW_ALLOWED_GROUP_IDS,
    allowAnyGroup: env.PUBLIC_BETA_ENABLED,
  };
  const recoveryDeployment: EscrowRecoveryDeployment = {
    cluster: env.SOLANA_NETWORK,
    genesisHash,
    programId,
    canonicalUsdcMint,
    relayerFeePayer: sponsor.publicKey.toBase58(),
    residualRecipient,
    custodyVersion: 1,
  };
  const controlDeployment: EscrowControlDeployment = {
    cluster: env.SOLANA_NETWORK,
    genesisHash,
    programId,
    custodyVersion: 1,
    feedOperatorAuthority: feedOperator.publicKey.toBase58(),
  };
  const runtime = createEscrowWave4Runtime({
    supabaseUrl: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    rpcUrl: env.SOLANA_RPC_URL,
    sponsor,
    marketCreationAuthority: marketCreationAuthoritySigner,
    feedOperator,
    oracleAttestations,
    marketDeployment,
    placementDeployment,
    recoveryDeployment,
    controlDeployment,
    intakeReadiness: () => readiness('intake'),
    recoveryReadiness: () => readiness('recovery'),
    clock,
    workerId: `engine-${process.pid}`,
    retryAt: (nowIso) => new Date(Date.parse(nowIso) + env.QUEUE_RETRY_BASE_MS).toISOString(),
    pointsProjection: options.pointsProjection,
    projectionSink: options.projectionSink,
    ...(options.onRelayerResults === undefined
      ? {}
      : { onRelayerResults: options.onRelayerResults }),
    ...(options.admitPeriodicReconciliationLink === undefined
      ? {}
      : { admitPeriodicReconciliationLink: options.admitPeriodicReconciliationLink }),
    worker: {
      intervalMs: env.ESCROW_WORKER_INTERVAL_MS,
      relayerLimit: 25,
      // Each attestation independently verifies real provider evidence at the
      // isolated signers. One lease per cycle prevents a 25x3 RPC fan-out.
      attestationLimit: 1,
      attestationLeaseMs: env.QUEUE_LEASE_MS,
      indexerLimit: env.ESCROW_INDEXER_PAGE_SIZE,
      log: options.log,
    },
    localForkIndexer: env.ESCROW_LOCAL_FORK_INDEXER,
  });
  runtimeIndexer = runtime.indexer;
  const telegram = createEscrowTelegramPort({
    placement: runtime.placement,
    identities: options.identities,
    walletSessions: options.walletSessions,
    network: env.SOLANA_NETWORK,
    sessionTtlSeconds: 300,
  });
  await runtime.groupRollouts.ensureEscrowGroups(env.ESCROW_ALLOWED_GROUP_IDS);
  return {
    ...runtime,
    telegram,
    oracleAttestations,
    marketCreationAuthoritySigner,
    readiness,
    marketPolicy: {
      oracleSetEpoch,
      maximumMarketDurationSeconds: config.value.maximumMarketDurationSeconds,
      maximumResolutionDelaySeconds: config.value.maximumResolutionDelaySeconds,
    },
  };
}

export function dependencyFailureReason(error: unknown): 'dependency_exception' {
  if (!(error instanceof Error)) throw error;
  return 'dependency_exception';
}

export type TxlineWarningReason =
  | 'feed_failure'
  | 'reconnect'
  | 'malformed'
  | 'normalization'
  | 'unknown';

function txlineWarningReason(message: string): TxlineWarningReason {
  switch (message) {
    case 'stream loop crashed':
    case 'replay loop crashed':
    case 'replay hit max virtual duration without a terminal phase':
    case 'replay could not start':
    case 'replay tick failed — continuing':
      return 'feed_failure';
    case 'stream error — will reconnect':
    case 'heartbeat timeout — reconnecting':
      return 'reconnect';
    case 'unexpected response shape':
    case 'skipped malformed records':
    case 'stream frame is not valid JSON':
    case 'skipping unparseable odds record':
    case 'skipping unparseable scores record':
      return 'malformed';
    case 'unknown SuperOddsType':
    case 'odds period rejected':
    case '1X2 probabilities do not sum to ~1':
    case 'totals record without a parseable line':
    case 'unknown StatusId — keeping previous phase':
    case 'amend/discard without resolvable original seq':
      return 'normalization';
    default:
      return 'unknown';
  }
}

export function createTxlineWarningLogger(log: Pick<Logger, 'warn'>): TxlineLogger {
  return (message) => log.warn('txline_warning', { reason: txlineWarningReason(message) });
}
