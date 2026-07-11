import {
  checkDebounce,
  compileClaim,
  priceSpec,
  reduceMarket,
  type RawClaimParse,
} from '@calledit/market-engine';
import type { EventSourceLike, Deps } from '../ports.js';
import type { LogFields, Logger } from '../log.js';
import { loadEnv } from '../env.js';
import { BASE_ENV } from '../env.test-fixtures.js';
import { createPoster } from '../bot/poster.js';
import { SendQueue } from '../bot/sendQueue.js';
import { renderFallback, type Say } from '../bot/copy.js';
import { LlmBudget } from '../bot/budget.js';
import { EntityCache } from '../bot/entities.js';
import type { HandlerCtx } from '../bot/context.js';
import { registerCommands } from '../bot/commands.js';
import { IngestSupervisor } from '../ingest/supervisor.js';
import { Settler } from '../settle/settler.js';
import { createGroupPointsService, type GroupPointsService } from './service.js';
import { TelegramFlowDb } from './telegram-points-flow-db.test-support.js';
import { TelegramTransport } from './telegram-points-flow-telegram.test-support.js';
import { TelegramFlowWager } from './telegram-points-flow-wager.test-support.js';
import {
  CALL_FIXTURES,
  GROUP_ONE_ID,
  GROUP_TWO_ID,
  GROUPS,
  NOW_MS,
  USERS,
  fixtureRows,
} from './telegram-points-flow-fixtures.test-support.js';

export type FlowLog = {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: LogFields | undefined;
};

export const RUNTIME_TELEGRAM_TOKEN_SENTINEL =
  '999999:RUNTIME_TELEGRAM_TOKEN_SENTINEL';

export class FlowLogger implements Logger {
  readonly events: FlowLog[] = [];
  info(event: string, fields?: LogFields): void { this.events.push({ level: 'info', event, fields }); }
  warn(event: string, fields?: LogFields): void { this.events.push({ level: 'warn', event, fields }); }
  error(event: string, fields?: LogFields): void { this.events.push({ level: 'error', event, fields }); }
  child(): Logger { return this; }
}

class UnknownCallFixture extends Error {
  readonly name = 'UnknownCallFixture';
  constructor(readonly text: string) { super(`Unknown call fixture: ${text}`); }
}

const ENV = loadEnv({
  ...BASE_ENV,
  TELEGRAM_BOT_TOKEN: RUNTIME_TELEGRAM_TOKEN_SENTINEL,
  WEB_BASE_URL: 'https://calledit.invalid',
  WALLET_LINK_DOMAIN: 'calledit.invalid',
  BETA_ALLOWED_GROUP_IDS: `${GROUP_ONE_ID},${GROUP_TWO_ID}`,
});

function rawParse(text: string): RawClaimParse {
  const fixture = CALL_FIXTURES.find((candidate) => candidate.text === text);
  if (fixture === undefined) throw new UnknownCallFixture(text);
  return {
    claimType: 'match_winner',
    fixtureId: fixture.fixtureId,
    entityName: fixture.team,
    entityKind: 'team',
    comparator: 'gte',
    threshold: 1,
    period: 'FT_90',
    unresolved: null,
  };
}

function eventSource(): EventSourceLike {
  return { start: () => undefined, stop: () => undefined, currentAsOfMs: () => null };
}

export type TelegramFlowRuntime = {
  readonly db: TelegramFlowDb;
  readonly transport: TelegramTransport;
  readonly queue: SendQueue;
  readonly wager: TelegramFlowWager;
  readonly points: GroupPointsService;
  readonly settler: Settler;
  readonly deps: Deps;
  readonly h: HandlerCtx;
  readonly log: FlowLogger;
  readonly bot: ReturnType<TelegramTransport['createBot']>;
};

export function createTelegramFlowRuntime(): TelegramFlowRuntime {
  const db = new TelegramFlowDb(() => NOW_MS);
  for (const group of GROUPS) db.seedGroup(group);
  for (const user of USERS) db.seedUser(user);
  for (const fixture of fixtureRows()) db.seedFixture(fixture);
  const log = new FlowLogger();
  const transport = new TelegramTransport(db.trace);
  const bot = transport.createBot();
  const queue = new SendQueue({
    ratePerMinute: 1_000,
    collapseMs: 0,
    now: () => NOW_MS,
    onError: (error) => log.error('telegram_send_failed', { error: String(error) }),
  });
  const poster = createPoster(bot.api, queue, log);
  const wager = new TelegramFlowWager(db, db.trace);
  const deps: Deps = {
    db,
    agent: {
      prefilter: () => true,
      classify: async () => ({ isClaim: true, confidence: 1, claimTypeGuess: 'match_winner' }),
      parse: async (text) => rawParse(text),
      persona: async (templateKey) => templateKey,
    },
    engine: { compileClaim, priceSpec, reduceMarket, checkDebounce },
    tx: {
      fetchOdds: async () => ({
        kind: 'ok',
        odds: {
          p1x2: { home: 0.6, draw: 0.25, away: 0.15 },
          totals: { line: 2.5, overProb: 0.55 },
          oddsMessageId: 'fixture-odds',
          oddsTsMs: NOW_MS - 1_000,
        },
      }),
      fetchFixtures: async () => [],
      fetchScoreEvents: async () => [],
      fetchStatProof: async () => null,
      createLiveSource: eventSource,
      createReplaySource: eventSource,
    },
    proofSubmitter: null,
    wager,
    readiness: {
      database: { probe: async () => undefined },
      feed: { snapshot: async () => ({ activePricingExpected: false, lastEventAtMs: null }) },
      wager: { snapshot: async () => ({ enabled: false, configured: false, paused: false, covered: false }) },
      proof: { snapshot: async () => ({ enabled: false, heartbeatAtMs: null, backlog: 0, oldestAgeMs: null }) },
      settlement: { snapshot: async () => ({ enabled: false, heartbeatAtMs: null, backlog: 0, oldestAgeMs: null }) },
    },
    drains: [],
    env: ENV,
    log,
    now: () => NOW_MS,
  };
  const say: Say = async (key, vars = {}) => renderFallback(key, vars);
  const points = createGroupPointsService({ db, log });
  const settler = new Settler(deps, poster, say, points, null);
  const supervisor = new IngestSupervisor(deps, settler);
  const h: HandlerCtx = {
    deps,
    queue,
    poster,
    say,
    supervisor,
    entities: new EntityCache(db, () => NOW_MS),
    budget: new LlmBudget(100, () => NOW_MS),
  };
  registerCommands(bot, h);
  return { db, transport, queue, wager, points, settler, deps, h, log, bot };
}
