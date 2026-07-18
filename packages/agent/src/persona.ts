/**
 * persona(), every consumer-facing string flows through here.
 *
 * The deterministic template bank is the source of truth; an optional
 * Haiku "garnish" may rephrase a line for flavour, but:
 *   - it only runs when a client AND a budget are provided and the budget
 *     grants a token (hard cap per match, enforced by construction),
 *   - it must finish inside GARNISH_TIMEOUT_MS,
 *   - its output must keep every number from the template, stay short and
 *     pass the deny-list guard,
 *   - ANY failure, error, timeout, empty output, guard violation, falls
 *     back to the rendered template. The bot is never blocked on a model.
 */

import { type AgentModelClient, responseText } from './client.js';
import {
  GARNISH_MAX_OUTPUT_CHARS,
  GARNISH_MAX_TOKENS,
  GARNISH_TIMEOUT_MS,
  PERSONA_GARNISH_MODEL,
} from './constants.js';
import { violatesDenyList } from './denylist.js';
import {
  type PersonaTemplateKey,
  type PersonaVars,
  renderTemplate,
  selectTemplate,
} from './templates.js';

/**
 * Injectable garnish cap. `tryConsume` returns false once the cap is spent.
 * The engine creates one per group per match from
 * TUNABLES.PERSONA_GENERATIONS_PER_MATCH.
 */
export interface GarnishBudget {
  tryConsume(): boolean;
  remaining(): number;
}

export function createGarnishBudget(cap: number): GarnishBudget {
  let left = Math.max(0, Math.floor(cap));
  return {
    tryConsume(): boolean {
      if (left <= 0) return false;
      left -= 1;
      return true;
    },
    remaining(): number {
      return left;
    },
  };
}

export interface PersonaOptions {
  /** Model client for the garnish pass. No client → template only. */
  client?: AgentModelClient;
  /** Per-match garnish cap. No budget → template only (cap by construction). */
  budget?: GarnishBudget;
  /** Set false to force the deterministic template. */
  garnish?: boolean;
  timeoutMs?: number;
  model?: string;
}

export const GARNISH_SYSTEM_PROMPT = [
  'Rewrite the given bot message with more game-show-host energy for a',
  'football group chat where Callie brokers bets on the group’s calls. Hard',
  'rules: keep every fact, name, percentage and amount exactly as given; keep',
  'it one short message; betting language is welcome ("back it", "bet',
  'against"). Amounts are devnet SOL, NEVER invent fiat currency or currency',
  'symbols. Prices are plain percentages, NEVER odds notation (like 11/1 or',
  '9-to-1). Reply with the rewritten message only.',
].join('\n');

const GARNISH_TIMED_OUT = Symbol('garnish-timeout');

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof GARNISH_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof GARNISH_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(GARNISH_TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const NUMBER_TOKEN_RE = /\d+(?:\.\d+)?/g;

/** Every numeric token from the template must survive the rewrite. */
function keepsAllNumbers(base: string, garnished: string): boolean {
  const required = base.match(NUMBER_TOKEN_RE) ?? [];
  return required.every((token) => garnished.includes(token));
}

function isAcceptableGarnish(base: string, garnished: string): boolean {
  const trimmed = garnished.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > Math.max(GARNISH_MAX_OUTPUT_CHARS, base.length * 2)) return false;
  if (!keepsAllNumbers(base, trimmed)) return false;
  if (violatesDenyList(trimmed) !== null) return false;
  return true;
}

export async function persona(
  templateKey: PersonaTemplateKey,
  vars: PersonaVars,
  opts: PersonaOptions = {},
): Promise<string> {
  const base = renderTemplate(selectTemplate(templateKey, vars), vars);

  const { client, budget } = opts;
  if (opts.garnish === false || client === undefined || budget === undefined) return base;
  if (!budget.tryConsume()) return base;

  try {
    const outcome = await withTimeout(
      client.messages.create({
        model: opts.model ?? PERSONA_GARNISH_MODEL,
        max_tokens: GARNISH_MAX_TOKENS,
        system: GARNISH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: base }],
      }),
      opts.timeoutMs ?? GARNISH_TIMEOUT_MS,
    );
    if (outcome === GARNISH_TIMED_OUT) return base;

    const garnished = responseText(outcome).trim();
    return isAcceptableGarnish(base, garnished) ? garnished : base;
  } catch {
    // Deterministic fallback on ANY garnish failure.
    return base;
  }
}
