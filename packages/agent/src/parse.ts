/**
 * Claim parse, the Sonnet-tier touchpoint.
 *
 * Forced tool use against grounded tools whose executors are injected by the
 * caller (engine wires them to the DB; tests wire fakes). Entity IDs the
 * tools don't return cannot exist in the output. The model finishes by
 * calling `submit_parse`; its zod-validated input becomes the RawClaimParse
 * handed to the deterministic compiler.
 */

import { z } from 'zod';
import type { CompileContext, GamePhase, RawClaimParse } from '@calledit/market-engine';
import {
  type AgentModelClient,
  type ModelMessageParam,
  type ModelToolDefinition,
  type ModelToolResultBlock,
  type ModelToolUseBlock,
  createModelClient,
} from './client.js';
import { CLAIM_TYPE_VALUES } from './claim-taxonomy.js';
import {
  MAX_PARSE_TOOL_ROUNDS,
  PARSE_MAX_TOKENS,
  PARSE_PROMPT_MAX_PLAYERS,
  PARSER_MODEL,
} from './constants.js';
import { AgentParseError, AgentResponseFormatError } from './errors.js';

// ── Grounded tool executors (injected) ────────────────────────────────────

export interface FixtureSearchResult {
  fixtureId: number;
  p1Name: string;
  p2Name: string;
  kickoffMs: number;
  phase: GamePhase;
}

export interface PlayerResolveResult {
  normativeId: number;
  name: string;
  participant: 1 | 2 | null;
}

export interface MarketMenuEntry {
  claimType: RawClaimParse['claimType'];
  mintable: boolean;
  reason?: string;
}

export interface ParseToolExecutors {
  searchFixtures(query: string): Promise<FixtureSearchResult[]>;
  resolvePlayer(name: string): Promise<PlayerResolveResult[]>;
  getMarketMenu(fixtureId: number): Promise<MarketMenuEntry[]>;
}

export interface ParseOptions {
  executors: ParseToolExecutors;
  /** Injectable for tests; defaults to a real model client (GLM). */
  client?: AgentModelClient;
  model?: string;
  maxTokens?: number;
  maxToolRounds?: number;
}

// ── Wire tool definitions ─────────────────────────────────────────────────

export const SEARCH_FIXTURES_TOOL = 'search_fixtures';
export const RESOLVE_PLAYER_TOOL = 'resolve_player';
export const GET_MARKET_MENU_TOOL = 'get_market_menu';
export const SUBMIT_PARSE_TOOL = 'submit_parse';

const NULLABLE_STRING = { type: ['string', 'null'] };
const NULLABLE_NUMBER = { type: ['number', 'null'] };

export const PARSE_TOOLS: ModelToolDefinition[] = [
  {
    name: SEARCH_FIXTURES_TOOL,
    description:
      'Search covered fixtures by team name or phrase. Returns fixtureId, team names, kickoff and phase. A claim can only reference a fixtureId returned by this tool.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Team name or phrase to search for' } },
      required: ['query'],
    },
  },
  {
    name: RESOLVE_PLAYER_TOOL,
    description:
      'Resolve a (possibly misspelled) player name to known players. Returns normativeId, canonical name and side. A player claim can only reference a player returned by this tool.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Player name as written in chat' } },
      required: ['name'],
    },
  },
  {
    name: GET_MARKET_MENU_TOOL,
    description: 'List which claim types are currently mintable for a fixture, with reasons.',
    input_schema: {
      type: 'object',
      properties: { fixtureId: { type: 'number', description: 'Fixture id from search_fixtures' } },
      required: ['fixtureId'],
    },
  },
  {
    name: SUBMIT_PARSE_TOOL,
    description:
      'Submit the final structured parse of the claim. Call this exactly once, after grounding the fixture (and player if applicable). Use null for anything the message does not state; put text you could not structure into "unresolved".',
    input_schema: {
      type: 'object',
      properties: {
        claimType: { enum: [...CLAIM_TYPE_VALUES, null] },
        fixtureId: NULLABLE_NUMBER,
        entityName: NULLABLE_STRING,
        entityKind: { enum: ['team', 'player', null] },
        comparator: { enum: ['gte', 'lte', 'eq', null] },
        threshold: NULLABLE_NUMBER,
        period: { enum: ['FT', 'FT_90', null] },
        unresolved: NULLABLE_STRING,
      },
      required: [],
    },
  },
];

// ── Final-output validation ───────────────────────────────────────────────

const rawClaimParseSchema = z
  .object({
    claimType: z.enum(CLAIM_TYPE_VALUES).nullish(),
    fixtureId: z.number().int().nullish(),
    entityName: z.string().nullish(),
    entityKind: z.enum(['team', 'player']).nullish(),
    comparator: z.enum(['gte', 'lte', 'eq']).nullish(),
    threshold: z.number().nullish(),
    period: z.enum(['FT', 'FT_90']).nullish(),
    unresolved: z.string().nullish(),
  })
  .transform(
    (value): RawClaimParse => ({
      claimType: value.claimType ?? null,
      fixtureId: value.fixtureId ?? null,
      entityName: value.entityName ?? null,
      entityKind: value.entityKind ?? null,
      comparator: value.comparator ?? null,
      threshold: value.threshold ?? null,
      period: value.period ?? null,
      unresolved: value.unresolved ?? null,
    }),
  );

/**
 * Some models (notably GLM) serialise a JSON null as the string "null" in
 * tool-call inputs. Both the tool's input_schema and rawClaimParseSchema treat
 * null/absent as "unstated", so fold the literal strings back to real null
 * before validation. No legitimate value in the closed taxonomy is the string
 * "null" or "undefined", so this cannot mask a real parse.
 */
function coerceModelNulls(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input;
  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    coerced[key] = value === 'null' || value === 'undefined' ? null : value;
  }
  // GLM type drift, observed live (2026-07-08): numeric fields arrive as
  // strings ("2" for threshold, fixture ids quoted) and comparator sometimes
  // comes back as the strict form ("gt"/"lt") the closed taxonomy doesn't
  // admit. Fold both at the boundary, LLM proposes, code disposes.
  for (const key of ['threshold', 'fixtureId'] as const) {
    const value = coerced[key];
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      coerced[key] = Number(value);
    }
  }
  const comparator = coerced['comparator'];
  const threshold = coerced['threshold'];
  if (comparator === 'gt' && typeof threshold === 'number' && Number.isInteger(threshold)) {
    // strictly-more-than N ≡ at-least N+1 for integer stats
    coerced['comparator'] = 'gte';
    coerced['threshold'] = threshold + 1;
  } else if (comparator === 'lt' && typeof threshold === 'number' && Number.isInteger(threshold)) {
    coerced['comparator'] = 'lte';
    coerced['threshold'] = threshold - 1;
  }
  return coerced;
}

// ── Prompt assembly ───────────────────────────────────────────────────────

export const PARSE_SYSTEM_PROMPT = [
  'You turn one football group-chat message into a structured claim parse.',
  'You MUST ground every reference through the tools: find the fixture with',
  `${SEARCH_FIXTURES_TOOL}; resolve player names with ${RESOLVE_PLAYER_TOOL};`,
  `check availability with ${GET_MARKET_MENU_TOOL} when unsure. Never invent`,
  'ids or names, only values returned by tools may appear in the parse.',
  '',
  'Parse faithfully, do not judge validity: capture what was said (comparator,',
  'threshold, period) and leave everything unstated as null. "in 90"/"in',
  'normal time" means period FT_90; "even if it goes to extra time/pens" or',
  '"advancing/through" means FT; otherwise period is null. "won\'t score"',
  'means comparator "eq" with threshold 0. A brace is 2 goals, a hat-trick 3.',
  'A claim that a team turns a losing position around is claimType "comeback".',
  'If the whole message is not really a bookable claim, still call',
  `${SUBMIT_PARSE_TOOL} with claimType null and the reason in "unresolved".`,
  '',
  `Finish by calling ${SUBMIT_PARSE_TOOL} exactly once.`,
].join('\n');

function describeContext(ctx: CompileContext): string {
  const lines: string[] = [`Now (unix ms): ${ctx.nowMs}`];
  if (ctx.fixture) {
    const f = ctx.fixture;
    lines.push(
      `Chat's active fixture: #${f.fixtureId} ${f.p1Name} vs ${f.p2Name}, ` +
        `kickoff ${f.kickoffMs} (unix ms), phase ${f.phase}` +
        (f.minute !== null ? `, minute ${f.minute}` : '') +
        `, score ${f.score.p1Goals}-${f.score.p2Goals}`,
    );
  } else {
    lines.push("Chat's active fixture: none known, search for one.");
  }
  if (ctx.knownPlayers.length > 0) {
    const names = ctx.knownPlayers
      .slice(0, PARSE_PROMPT_MAX_PLAYERS)
      .map((p) => p.name)
      .join(', ');
    lines.push(`Players already known for this fixture: ${names}`);
  }
  return lines.join('\n');
}

// ── Executor dispatch ─────────────────────────────────────────────────────

async function executeTool(
  executors: ParseToolExecutors,
  toolUse: ModelToolUseBlock,
): Promise<string> {
  const input = (toolUse.input ?? {}) as Record<string, unknown>;
  switch (toolUse.name) {
    case SEARCH_FIXTURES_TOOL:
      return JSON.stringify(await executors.searchFixtures(String(input.query ?? '')));
    case RESOLVE_PLAYER_TOOL:
      return JSON.stringify(await executors.resolvePlayer(String(input.name ?? '')));
    case GET_MARKET_MENU_TOOL:
      return JSON.stringify(await executors.getMarketMenu(Number(input.fixtureId)));
    default:
      throw new AgentParseError(`model called unknown tool "${toolUse.name}"`);
  }
}

// ── Model selection ───────────────────────────────────────────────────────

/**
 * Resolve the parser model. An explicit `opts.model` always wins (tests pin
 * it); otherwise `GLM_PARSER_MODEL` overrides the pinned default, so a bad
 * GLM-5.2 day rolls back with one env change instead of a redeploy.
 */
export function resolveParserModel(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return explicit ?? env.GLM_PARSER_MODEL ?? PARSER_MODEL;
}

// ── The loop ──────────────────────────────────────────────────────────────

export async function parseClaim(
  text: string,
  ctx: CompileContext,
  opts: ParseOptions,
): Promise<RawClaimParse> {
  const client = opts.client ?? createModelClient();
  const maxRounds = opts.maxToolRounds ?? MAX_PARSE_TOOL_ROUNDS;
  const model = resolveParserModel(opts.model);

  const messages: ModelMessageParam[] = [
    {
      role: 'user',
      content: `${describeContext(ctx)}\n\nMessage to parse: ${JSON.stringify(text)}`,
    },
  ];

  for (let round = 0; round < maxRounds; round += 1) {
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? PARSE_MAX_TOKENS,
      system: PARSE_SYSTEM_PROMPT,
      messages,
      tools: PARSE_TOOLS,
      // Forced tool use: every round must be a tool call, never free text.
      tool_choice: { type: 'any' },
    });

    const toolUses = response.content.filter(
      (block): block is ModelToolUseBlock => block.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      throw new AgentParseError(
        `parse round ${round}: model returned no tool call despite forced tool use`,
      );
    }

    const submit = toolUses.find((block) => block.name === SUBMIT_PARSE_TOOL);
    if (submit) {
      const validated = rawClaimParseSchema.safeParse(coerceModelNulls(submit.input) ?? {});
      if (!validated.success) {
        throw new AgentResponseFormatError(
          `submit_parse input failed validation: ${validated.error.message}`,
          JSON.stringify(submit.input),
        );
      }
      return validated.data;
    }

    messages.push({ role: 'assistant', content: response.content });

    const results: ModelToolResultBlock[] = [];
    for (const toolUse of toolUses) {
      try {
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: await executeTool(opts.executors, toolUse),
        });
      } catch (error) {
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `tool failed: ${(error as Error).message}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  throw new AgentParseError(
    `parse gave up after ${maxRounds} tool rounds without a ${SUBMIT_PARSE_TOOL} call`,
  );
}
