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
import { createEngineDb } from '@calledit/db';
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
import { Connection, loadWallet, submitValidateStat } from '@calledit/solana';
import type {
  AgentPort,
  Deps,
  EngineDb,
  EnginePort,
  EventSourceLike,
  ProofSubmitter,
  TxPort,
} from './ports.js';
import type { Env } from './env.js';
import type { Logger } from './log.js';
import { mapFixtureRecord } from './ingest/fixtureMap.js';
import { mapStatValidationToParams } from './proofs/mapping.js';

// ── Dependency construction ───────────────────────────────────────────────

export function createDeps(env: Env, log: Logger): Deps {
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

  return { db, agent, engine, tx, proofSubmitter, env, log, now: () => Date.now() };
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
