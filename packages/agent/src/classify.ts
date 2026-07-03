/**
 * Claim classification — the Haiku-tier touchpoint behind the prefilter.
 *
 * Strict JSON in/out: the model gets the message plus entity hints and must
 * answer only `{"is_claim", "confidence", "claim_type_guess"}`. Anything it
 * says is advisory — thresholds and all state changes live in the engine and
 * compiler ("LLM proposes, code disposes").
 */

import { z } from 'zod';
import type { ClaimType } from '@calledit/market-engine';
import {
  type AgentModelClient,
  createModelClient,
  responseText,
} from './client.js';
import { CLAIM_TYPE_VALUES, isClaimType } from './claim-taxonomy.js';
import { CLASSIFIER_MODEL, CLASSIFY_MAX_TOKENS } from './constants.js';
import { AgentResponseFormatError } from './errors.js';

export interface EntityHints {
  teamNames: string[];
  playerNames: string[];
}

export interface ClassifyResult {
  isClaim: boolean;
  /** Clamped to [0, 1]; engine compares against the nudge/react tunables. */
  confidence: number;
  claimTypeGuess: ClaimType | null;
}

export interface ClassifyOptions {
  /** Injectable for tests; defaults to a real model client (GLM). */
  client?: AgentModelClient;
  model?: string;
  maxTokens?: number;
}

export const CLASSIFY_SYSTEM_PROMPT = [
  'You are the claim detector for a football group-chat game. A "claim" is a',
  'confident prediction about a specific upcoming or in-play match outcome that',
  'friends could hold the speaker to — e.g. who wins, total goals, a team or',
  'player scoring N, both teams scoring, or a losing team turning it around.',
  '',
  'NOT claims: commentary or reactions about events that already happened,',
  'stats, questions, logistics, jokes, or vague hype with no checkable outcome.',
  '',
  `Known claim types: ${CLAIM_TYPE_VALUES.join(', ')}.`,
  '',
  'Respond with ONLY a single JSON object — no prose, no code fences:',
  '{"is_claim": boolean, "confidence": number between 0 and 1,',
  ' "claim_type_guess": one of the known claim types or null}',
].join('\n');

const classifyResponseSchema = z.object({
  is_claim: z.boolean(),
  confidence: z.number(),
  claim_type_guess: z.string().nullish(),
});

const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 1;

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return CONFIDENCE_MIN;
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, value));
}

/** Pull the first {...} JSON object out of a model reply (fences tolerated). */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new AgentResponseFormatError('classifier returned no JSON object', raw);
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as unknown;
  } catch (error) {
    throw new AgentResponseFormatError(
      `classifier returned malformed JSON: ${(error as Error).message}`,
      raw,
    );
  }
}

export async function classifyMessage(
  text: string,
  entityHints: EntityHints,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const client = opts.client ?? createModelClient();
  const userPrompt = [
    `Message: ${JSON.stringify(text)}`,
    `Teams playing soon: ${entityHints.teamNames.join(', ') || '(none known)'}`,
    `Known players: ${entityHints.playerNames.join(', ') || '(none known)'}`,
  ].join('\n');

  const response = await client.messages.create({
    model: opts.model ?? CLASSIFIER_MODEL,
    max_tokens: opts.maxTokens ?? CLASSIFY_MAX_TOKENS,
    system: CLASSIFY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = responseText(response);
  const parsed = classifyResponseSchema.safeParse(extractJsonObject(raw));
  if (!parsed.success) {
    throw new AgentResponseFormatError(
      `classifier JSON failed validation: ${parsed.error.message}`,
      raw,
    );
  }

  const guess = parsed.data.claim_type_guess;
  return {
    isClaim: parsed.data.is_claim,
    confidence: clampConfidence(parsed.data.confidence),
    claimTypeGuess: isClaimType(guess) ? guess : null,
  };
}
