/**
 * The ONLY module that imports sibling workspace packages directly.
 * Everything else consumes them through the ports defined in ports.ts, so any
 * drift between CONTRACTS.md and a sibling's real surface is fixed here alone.
 */

import {
  CLAIM_TYPES,
  checkDebounce,
  compileClaim,
  priceSpec,
  reduceMarket,
  type MatchEvent,
} from '@calledit/market-engine';
import { createEngineDb, createWagerDb } from '@calledit/db';
import {
  classifyMessage,
  parseClaim,
  persona,
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
  type Keypair,
} from '@calledit/solana';
import type {
  AgentPort,
  Deps,
  EngineDb,
  EnginePort,
  EventSourceLike,
  ProofSubmitter,
  TxPort,
} from './ports.js';
import type { WagerModule, WagerModuleDeps, WagerPoster } from './wager/module.js';
import type { Env } from './env.js';
import type { Logger } from './log.js';
import { mapFixtureRecord } from './ingest/fixtureMap.js';
import { mapStatValidationToParams } from './proofs/mapping.js';

// ── Dependency construction ───────────────────────────────────────────────

export async function createDeps(
  env: Env,
  log: Logger,
  /** Rate-limited chat poster — required only when wager mode is enabled. */
  wagerPoster?: WagerPoster,
): Promise<Deps> {
  const db = createEngineDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY) as unknown as EngineDb;

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
    persona: (templateKey, vars) => persona(templateKey as PersonaTemplateKey, vars),
  };

  const txLogger: TxlineLogger = (message, context) => log.warn(`txline: ${message}`, context);

  const client = new TxlineClient({
    apiBase: env.TXLINE_API_BASE,
    guestJwt: env.TXLINE_GUEST_JWT,
    apiToken: env.TXLINE_API_TOKEN,
    logger: txLogger,
  });

  const cursorStore = {
    get: (name: string) => db.getCursor(name),
    set: (name: string, id: string) => db.setCursor(name, id),
  };

  const tx: TxPort = {
    fetchOdds: async (fixtureId, asOfMs) => {
      let odds;
      let recordCount = 0;
      try {
        const records = await client.oddsSnapshot(fixtureId, asOfMs);
        recordCount = records.length;
        odds = combineOddsSnapshot(records, { logger: txLogger });
      } catch (err) {
        log.warn('odds_snapshot_failed', { fixtureId, error: String(err) });
        return { kind: 'transient' };
      }
      if (!odds) {
        // The fetch worked — the feed just has nothing usable for this
        // fixture. Logged so inventory gaps are distinguishable from outages.
        log.info('odds_snapshot_empty', { fixtureId, recordCount });
        return { kind: 'no_odds' };
      }
      return { kind: 'ok', odds };
    },
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

  const proofSubmitter: ProofSubmitter | null = buildProofSubmitter(env, log);
  const wager: WagerModule | null = await buildWagerModule(env, log, db, wagerPoster);

  return { db, agent, engine, tx, proofSubmitter, wager, env, log, now: () => Date.now() };
}

// ── Wager module construction (nullable degrade, like the proof submitter) ──

type WagerModuleDb = WagerModuleDeps['db'];
type WagerChainPort = WagerModuleDeps['chain'];

/**
 * The dynamic import keeps ./wager/module.js completely unreachable at
 * runtime unless BOTH gates pass, so a flag-off deploy never loads a byte of
 * wager code. Uses the DEDICATED wager treasury keypair; the TxL-holding
 * SOLANA_KEYPAIR_B58 must never touch wager flows (sponsor terms) — env.ts
 * refuses to boot if the two are the same key.
 */
async function buildWagerModule(
  env: Env,
  log: Logger,
  engineDb: EngineDb,
  poster: WagerPoster | undefined,
): Promise<WagerModule | null> {
  if (env.WAGER_MODE_ENABLED !== 'true') return null;
  const treasurySecret = env.WAGER_TREASURY_KEYPAIR_B58;
  if (!treasurySecret) {
    log.warn('wager_module_disabled', { reason: 'WAGER_TREASURY_KEYPAIR_B58 not set' });
    return null;
  }
  if (!poster) {
    // Programming error, not configuration: main.ts must construct the poster
    // before deps when the flag is on. Fail loud rather than run silent.
    throw new Error('wager module requires a poster — pass one to createDeps');
  }
  const treasury = loadWallet(treasurySecret);
  // Long-lived Connection, constructed once per process for the module.
  const connection = new Connection(env.SOLANA_RPC_URL, 'confirmed');
  const { createWagerModule } = await import('./wager/module.js');
  return createWagerModule({
    db: buildWagerModuleDb(env, engineDb),
    chain: buildWagerChain(connection, treasury),
    poster,
    log,
    now: () => Date.now(),
    opsChatId: parseOpsChatId(env, log),
  });
}

/**
 * The module's WagerDb port = packages/db's wager facade plus the handful of
 * SHARED-table reads (positions, cursors, user names) served by the engine
 * facade, so neither package grows a dependency on the other.
 */
function buildWagerModuleDb(env: Env, engineDb: EngineDb): WagerModuleDb {
  const wagerDb = createWagerDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  // Migration 0002 ships no advisory-lock RPC, so cron singleton guarding is
  // in-process (the engine is one Node process). Rolling-deploy overlap can
  // double-run a tick; every money movement stays idempotent via unique keys,
  // so the worst case is a duplicated chat line — cosmetic, not monetary.
  const heldCronLocks = new Set<string>();
  return {
    ...wagerDb,
    // Port wants Promise<void>; the facade reports {updated}/{inserted}.
    async markWithdrawalSubmitted(id, tx) {
      await wagerDb.markWithdrawalSubmitted(id, tx);
    },
    async markWithdrawalConfirmed(id) {
      await wagerDb.markWithdrawalConfirmed(id);
    },
    async markWithdrawalFailed(id, error) {
      await wagerDb.markWithdrawalFailed(id, error);
    },
    async insertSettlementApplied(marketId) {
      await wagerDb.insertSettlementApplied(marketId);
    },
    // Shared tables — engine facade owns these.
    positionsForMarket: (marketId) => engineDb.positionsForMarket(marketId),
    setPositionStates: (ids, state) => engineDb.setPositionStates(ids, state),
    getCursor: (streamName) => engineDb.getCursor(streamName),
    setCursor: (streamName, value) => engineDb.setCursor(streamName, value),
    getUserName: async (userId) => (await engineDb.getUser(userId))?.display_name ?? null,
    async tryCronLock(name) {
      if (heldCronLocks.has(name)) return false;
      heldCronLocks.add(name);
      return true;
    },
    async releaseCronLock(name) {
      heldCronLocks.delete(name);
    },
  };
}

/** Binds packages/solana's pure chain I/O to the module's WagerChain port. */
function buildWagerChain(connection: Connection, treasury: Keypair): WagerChainPort {
  const treasuryAddress = treasury.publicKey.toBase58();
  // Retry-wrapped Connection facets for the calls transfer.ts does not retry
  // itself (fetchIncomingTransfers applies withRetry internally).
  const retryRpc = {
    sendRawTransaction: (raw: Buffer, options?: { skipPreflight?: boolean }) =>
      withRetry(() => connection.sendRawTransaction(raw, options)),
    getSignatureStatuses: (sigs: string[], config?: { searchTransactionHistory?: boolean }) =>
      withRetry(() =>
        connection.getSignatureStatuses(sigs, {
          searchTransactionHistory: config?.searchTransactionHistory ?? false,
        }),
      ),
    getBlockHeight: (commitment?: 'confirmed' | 'finalized') =>
      withRetry(() => connection.getBlockHeight(commitment)),
  };
  return {
    treasuryPubkey: () => treasuryAddress,
    async treasuryBalanceLamports() {
      try {
        const lamports = await withRetry(() =>
          connection.getBalance(treasury.publicKey, 'confirmed'),
        );
        return { ok: true, lamports: BigInt(lamports) };
      } catch (err) {
        return { ok: false, error: `getBalance: ${String(err)}` };
      }
    },
    async buildTransfer({ to, lamports }) {
      let latest: { blockhash: string; lastValidBlockHeight: number };
      try {
        latest = await withRetry(() => connection.getLatestBlockhash('finalized'));
      } catch (err) {
        return { ok: false, error: `getLatestBlockhash: ${String(err)}` };
      }
      const built = buildSolTransfer({
        from: treasury,
        to,
        lamports,
        recentBlockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
      // buildSolTransfer is pure — same inputs fail the same way forever.
      if (!built.ok) return { ok: false, error: built.error, permanent: true };
      return {
        ok: true,
        sig: built.sig,
        rawTxB64: built.rawTxB64,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      };
    },
    broadcastRawTx: (rawTxB64) => broadcastRawTx(retryRpc, rawTxB64),
    getSigStatus: (sig) => getSigStatus(retryRpc, sig),
    isBlockheightExceeded: (lastValidBlockHeight) =>
      isBlockheightExceeded(retryRpc, lastValidBlockHeight),
    fetchIncomingTransfers: ({ untilSig }) =>
      fetchIncomingTransfers(connection, treasuryAddress, { untilSig: untilSig ?? undefined }),
  };
}

function parseOpsChatId(env: Env, log: Logger): number | null {
  const raw = env.WAGER_OPS_CHAT_ID;
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    log.warn('wager_ops_chat_invalid', { raw });
    return null;
  }
  return parsed;
}

function buildProofSubmitter(env: Env, log: Logger): ProofSubmitter | null {
  const secret = env.SOLANA_KEYPAIR_B58;
  if (!secret) {
    log.warn('proof_submitter_disabled', { reason: 'SOLANA_KEYPAIR_B58 not set' });
    return null;
  }
  return {
    async submit(args) {
      try {
        const mapped = mapStatValidationToParams(args.proof, args.comparator, args.threshold);
        if (!mapped) {
          return {
            ok: false,
            permanent: true,
            error: 'stat-validation payload missing required proof fields',
          };
        }
        const wallet = loadWallet(secret);
        const connection = new Connection(env.SOLANA_RPC_URL, 'confirmed');
        const result = await submitValidateStat({
          connection,
          wallet,
          programId: env.TXORACLE_PROGRAM_ID,
          ...mapped,
        });
        if (result.ok) return { ok: true, txSig: result.txSig };
        return { ok: false, error: result.error };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  };
}
