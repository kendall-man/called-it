/**
 * Agent-local tunables. Product-wide tunables live in
 * @calledit/market-engine constants — these are the LLM-plumbing knobs
 * only this package cares about.
 */

/** Fast classifier model — exact ID pinned by CONTRACTS.md. */
export const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

/** Structuring/parse model — exact ID pinned by CONTRACTS.md. */
export const PARSER_MODEL = 'claude-sonnet-5';

/** Persona garnish reuses the cheap classifier-tier model. */
export const PERSONA_GARNISH_MODEL = CLASSIFIER_MODEL;

/** Output budget for the strict-JSON classifier response. */
export const CLASSIFY_MAX_TOKENS = 300;

/** Output budget per parse round (tool calls + final submit). */
export const PARSE_MAX_TOKENS = 1200;

/** Output budget for a one-line persona garnish rewrite. */
export const GARNISH_MAX_TOKENS = 200;

/** Hard ceiling on tool-use rounds before parseClaim gives up. */
export const MAX_PARSE_TOOL_ROUNDS = 8;

/** Garnish must land within this window or the template ships as-is. */
export const GARNISH_TIMEOUT_MS = 1500;

/** Garnish longer than this is rejected — chat copy stays punchy. */
export const GARNISH_MAX_OUTPUT_CHARS = 320;

/** Cap on knownPlayers names embedded in the parse system prompt. */
export const PARSE_PROMPT_MAX_PLAYERS = 60;
