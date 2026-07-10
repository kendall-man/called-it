/**
 * The ONLY module that imports sibling workspace packages directly.
 * Everything else consumes them through the ports defined in ports.ts, so any
 * drift between CONTRACTS.md and a sibling's real surface is fixed here alone.
 */

import { CLAIM_TYPES, checkDebounce, compileClaim, priceSpec, reduceMarket, type MatchEvent } from '@calledit/market-engine';
import { createEngineDb, createWagerDb } from '@calledit/db';
import {
  classifyMessage,
  parseClaim,
  persona,
  PERSONA_TEMPLATE_KEYS,
  prefilter,
  type ParseToolExecutors,
  type PersonaTemplateKey,
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
  Connection,
  fetchIncomingTransfers,
  getSigStatus,
  isBlockheightExceeded,
  loadWallet,
  submitValidateStat,
  withRetry,
} from '@calledit/solana';
import type { AgentPort, Deps, EngineDb, EnginePort, EventSourceLike, OddsFetchResult, ProofSubmitter, TxPort } from './ports.js';
import type { WagerModule, WagerPoster } from './wager/module.js';
import type { Env } from './env.js';
import type { Logger } from './log.js';
import { mapFixtureRecord } from './ingest/fixtureMap.js';
import { ENGINE } from './engineConstants.js';
import { bindAbortSignalToFetch } from './api/readiness-http.js';
import { createProductionReadinessPorts } from './api/readiness-production.js';
import { createSupabaseReadinessClient } from './api/readiness-supabase.js';
import { createProductionProofSubmitter } from './wiring-proof.js';
import { createProductionWagerModule } from './wiring-wager.js';

// ── Dependency construction ───────────────────────────────────────────────

export async function createDeps(
  env: Env,
  log: Logger,
  /** Rate-limited chat poster — required only when wager mode is enabled. */
  wagerPoster?: WagerPoster,
): Promise<Deps> {
  const now = () => Date.now();
  const db: EngineDb = createEngineDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const engine: EnginePort = { compileClaim, priceSpec, reduceMarket, checkDebounce };

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
    persona: (templateKey, vars) => {
      if (!isPersonaTemplateKey(templateKey)) throw new Error('unknown persona template');
      return persona(templateKey, vars);
    },
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
    } catch (err) {
      signal?.throwIfAborted();
      log.warn('odds_snapshot_failed', { fixtureId, error: String(err) });
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
          } catch (err) {
            log.warn('gap_fill_failed', { fixtureId, error: String(err) });
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

  const proofSubmitter: ProofSubmitter | null = createProductionProofSubmitter(env, log, {
    createConnection: (rpcUrl) => new Connection(rpcUrl, 'confirmed'),
    loadWallet,
    submit: (input) => submitValidateStat(input),
  });
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
  const readinessDatabase = createSupabaseReadinessClient({
    baseUrl: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const readiness = createProductionReadinessPorts({
    database: readinessDatabase,
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
    proofEnabled: proofSubmitter !== null,
    settlementEnabled: false,
  });

  return {
    db,
    agent,
    engine,
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

function isPersonaTemplateKey(value: string): value is PersonaTemplateKey {
  return PERSONA_TEMPLATE_KEYS.some((key) => key === value);
}
