/**
 * Callie — the Called It concierge. Runtime config.
 *
 * Model: GLM (Z.ai) through its Anthropic-compatible endpoint, the same
 * provider the engine uses, so the two surfaces share one cost profile.
 * Validated 2026-07-18: `createAnthropic({ baseURL: <GLM>/v1 })("glm-5.2")`
 * returns clean completions through the AI SDK. To fall back to the Vercel
 * AI Gateway swap `model` for the string "anthropic/claude-sonnet-5".
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { defineAgent } from 'eve';
import { loadConciergeEnv } from './env.js';

const env = loadConciergeEnv();

const PARSER_MODEL = 'glm-5.2';

// Session token ceilings — the concierge answers short Telegram turns; a
// session that burns past these is a runaway, not a conversation (NL-spec R1).
const MAX_INPUT_TOKENS_PER_SESSION = 300_000;
const MAX_OUTPUT_TOKENS_PER_SESSION = 10_000;

const glm = createAnthropic({
  // The AI SDK provider appends /v1/messages relative to this base.
  baseURL: `${env.GLM_BASE_URL}/v1`,
  apiKey: env.GLM_API_KEY,
});

export default defineAgent({
  model: glm(PARSER_MODEL),
  // GLM is not in the AI Gateway catalog, so eve cannot look up its context
  // window — supply it verbatim (glm-5.2 has a 1M window, validated
  // 2026-07-18) or the build fails compiling compaction.
  modelContextWindowTokens: 1_000_000,
  limits: {
    maxInputTokensPerSession: MAX_INPUT_TOKENS_PER_SESSION,
    maxOutputTokensPerSession: MAX_OUTPUT_TOKENS_PER_SESSION,
    // Minimal delegation: the `agent` built-in cannot be disabled via
    // disableTool and the validator rejects 0 — cap at one level (a delegate
    // inherits the same locked-down toolset) and forbid it in instructions.
    maxSubagentDepth: 1,
  },
});
