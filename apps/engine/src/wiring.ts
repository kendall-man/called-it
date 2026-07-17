/**
 * The ONLY module that imports sibling workspace packages directly.
 * Everything else consumes them through the ports defined in ports.ts, so any
 * drift between CONTRACTS.md and a sibling's real surface is fixed here alone.
 */

import { CLAIM_TYPES, checkDebounce, compileClaim, priceSpec, reduceMarket, type MatchEvent } from '@calledit/market-engine';
import {
  createEngineDb,
  createProofSubmissionOutboxDb,
  createSettlementProofJobsDb,
  createTelegramDb,
  createWagerDb,
  type ProofSubmissionOutboxDb,
  type SettlementProofJobsDb,
  type TelegramDb,
} from '@calledit/db';
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
  broadcastRawTx,
  buildSolTransfer,
  buildSignedValidateStatSubmission,
  Connection,
  fetchIncomingTransfers,
  getSigStatus,
  isBlockheightExceeded,
  inspectProofSubmission,
  loadWallet,
  rebroadcastProofSubmission,
  withRetry,
} from '@calledit/solana';
import { z } from 'zod';
import type { AgentPort, Deps, EngineDb, EventSourceLike, OddsFetchResult, TxPort } from './ports.js';
import type { WagerModule, WagerPoster } from './wager/module.js';
import type { Env } from './env.js';
import type { Logger } from './log.js';
import { mapFixtureRecord } from './ingest/fixtureMap.js';
import { ENGINE } from './engineConstants.js';
import { bindAbortSignalToFetch } from './api/readiness-http.js';
import { createSupabaseProductionReadinessPorts } from './api/readiness-production.js';
import { resolvePersonaTemplateKey } from './wiring-agent.js';
import { createProductionWagerModule } from './wiring-wager.js';
import { mapStatValidationToParams } from './proofs/mapping.js';
import type { DurableProofSubmissionTransport } from './proofs/proof-submission.js';
import type { SettlementFactSource } from './settle/recovery-types.js';
import { statKeyForSpec } from './settle/statKeys.js';

const SettlementFactRows = z.array(z.object({
  outcome: z.enum(['claim_won', 'claim_lost', 'void']),
  deciding_seq: z.number().int().nullable(),
  tier: z.enum(['chain_proven', 'oracle_resolved']),
}).strict());

export interface ProductionRuntimeFacades {
  readonly proofOutbox: ProofSubmissionOutboxDb;
  readonly proofSubmission: DurableProofSubmissionTransport | null;
  readonly settlementFacts: SettlementFactSource;
  readonly settlementJobs: SettlementProofJobsDb;
  readonly telegram: TelegramDb;
}

export type ProductionDeps = Deps & { readonly runtime: ProductionRuntimeFacades };

// ── Dependency construction ───────────────────────────────────────────────

export async function createDeps(
  env: Env,
  log: Logger,
  /** Rate-limited chat poster — required only when wager mode is enabled. */
  wagerPoster?: WagerPoster,
): Promise<ProductionDeps> {
  const now = () => Date.now();
  const db: EngineDb = createEngineDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

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

  const txLogger: TxlineLogger = (message, context) => log.warn(`txline: ${message}`, context);

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
      const message = dependencyErrorMessage(error);
      log.warn('odds_snapshot_failed', { fixtureId, error: message });
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
            const message = dependencyErrorMessage(error);
            log.warn('gap_fill_failed', { fixtureId, error: message });
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

  // Proof submission is exclusively owned by the durable Task 17 outbox.
  // Keep the legacy port disabled so production composition cannot revive the
  // volatile proof-worker path by accident.
  const proofSubmitter = null;
  const wager: WagerModule | null = await createProductionWagerModule({
    env,
    log,
    engineDb: db,
    poster: wagerPoster,
    createDb: (url, serviceRoleKey) => createWagerDb(url, serviceRoleKey),
    createConnection: (rpcUrl) => new Connection(rpcUrl, 'confirmed'),
    loadTreasury: loadWallet,
    chainRuntime: {
      publicKey: (treasury) => treasury.publicKey,
      publicKeyAddress: (publicKey) => publicKey.toBase58(),
      getBalance: (connection, publicKey) => connection.getBalance(publicKey, 'confirmed'),
      getLatestBlockhash: (connection) => connection.getLatestBlockhash('finalized'),
      sendRawTransaction: (connection, raw, options) =>
        connection.sendRawTransaction(raw, options),
      getSignatureStatuses: (connection, signatures, config) =>
        connection.getSignatureStatuses(signatures, {
          searchTransactionHistory: config?.searchTransactionHistory ?? false,
        }),
      getBlockHeight: (connection, commitment) => connection.getBlockHeight(commitment),
      retry: (operation) => withRetry(operation),
      buildSolTransfer: (args) => buildSolTransfer(args),
      broadcastRawTx: (rpc, rawTxB64) => broadcastRawTx(rpc, rawTxB64),
      getSigStatus: (rpc, sig) => getSigStatus(rpc, sig),
      isBlockheightExceeded: (rpc, height) => isBlockheightExceeded(rpc, height),
      fetchIncomingTransfers: (connection, address, options) =>
        fetchIncomingTransfers(connection, address, options),
    },
  });
  const runtime = createProductionRuntimeFacades(env, db, log);
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
    wagerEnabled: env.WAGER_MODE_ENABLED === 'true',
    wagerConfigured: wager !== null,
    proofEnabled: runtime.proofSubmission !== null,
    settlementEnabled: wager !== null,
  });

  return {
    db,
    agent,
    engine: { compileClaim, priceSpec, reduceMarket, checkDebounce },
    tx,
    proofSubmitter,
    runtime,
    wager,
    readiness,
    drains: [],
    env,
    log,
    now,
  };
}

function createProductionRuntimeFacades(
  env: Env,
  db: EngineDb,
  log: Logger,
): ProductionRuntimeFacades {
  return {
    proofOutbox: createProofSubmissionOutboxDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
    proofSubmission: createProductionDurableProofSubmission(env, log),
    settlementFacts: createSettlementFactSource(env, db),
    settlementJobs: createSettlementProofJobsDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
    telegram: createTelegramDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
  };
}

function createSettlementFactSource(env: Env, db: EngineDb): SettlementFactSource {
  return {
    async find(marketId) {
      const market = await db.getMarket(marketId);
      if (market === null || market.currency !== 'sol') return null;

      const url = new URL('/rest/v1/settlements', env.SUPABASE_URL);
      url.searchParams.set('select', 'outcome,deciding_seq,tier');
      url.searchParams.set('market_id', `eq.${marketId}`);
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (!response.ok) throw new Error('settlement fact request failed');

      const settlement = SettlementFactRows.parse(await response.json())[0];
      if (settlement === undefined || settlement.tier !== market.spec.trustTier) return null;
      return {
        marketId,
        fixtureId: market.fixture_id,
        outcome: settlement.outcome,
        tier: settlement.tier,
        decidingSeq: settlement.deciding_seq,
        comparator: market.spec.comparator,
        threshold: market.spec.threshold,
        statKey: statKeyForSpec(market.spec),
      };
    },
  };
}

function createProductionDurableProofSubmission(
  env: Env,
  log: Logger,
): DurableProofSubmissionTransport | null {
  const secret = env.SOLANA_KEYPAIR_B58;
  if (secret === undefined) {
    log.warn('durable_proof_submission_disabled', { reason: 'SOLANA_KEYPAIR_B58 not set' });
    return null;
  }
  const connection = new Connection(env.SOLANA_RPC_URL, 'confirmed');
  const wallet = loadWallet(secret);
  return {
    async build(input) {
      const mapped = mapStatValidationToParams(input.proof, input.comparator, input.threshold);
      if (mapped === null) return { ok: false };
      const built = await buildSignedValidateStatSubmission({
        connection,
        wallet,
        programId: env.TXORACLE_PROGRAM_ID,
        ...mapped,
      });
      return built.ok ? built : { ok: false };
    },
    async inspect(submission) {
      const inspected = await inspectProofSubmission(connection, submission);
      if (!inspected.ok) return { ok: false };
      return {
        ok: true,
        plan: inspected.plan.kind === 'onchain_failed'
          ? { kind: 'onchain_failed' as const }
          : inspected.plan,
      };
    },
    async rebroadcast(submission) {
      const broadcast = await rebroadcastProofSubmission(connection, submission);
      return broadcast.ok ? { ok: true } : { ok: false };
    },
  };
}

export function dependencyErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) throw error;
  return error.message;
}
