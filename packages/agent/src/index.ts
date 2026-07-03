/**
 * @calledit/agent — the three LLM touchpoints (classify, parse, persona)
 * plus the deterministic prefilter and the golden fixture set.
 *
 * "LLM proposes, code disposes": nothing exported here mutates state; the
 * engine feeds outputs through @calledit/market-engine's compiler gate.
 */

export {
  CLASSIFIER_MODEL,
  PARSER_MODEL,
  PERSONA_GARNISH_MODEL,
  GARNISH_TIMEOUT_MS,
  MAX_PARSE_TOOL_ROUNDS,
} from './constants.js';

export { AgentError, AgentParseError, AgentResponseFormatError } from './errors.js';

export {
  createModelClient,
  DEFAULT_MODEL_BASE_URL,
  responseText,
  type AgentModelClient,
  type ModelContentBlock,
  type ModelMessageParam,
  type ModelRequest,
  type ModelResponse,
  type ModelTextBlock,
  type ModelToolChoice,
  type ModelToolDefinition,
  type ModelToolResultBlock,
  type ModelToolUseBlock,
} from './client.js';

export { CLAIM_TYPE_VALUES, isClaimType } from './claim-taxonomy.js';

export { prefilter, normalizeForMatch, type PrefilterEntities } from './prefilter.js';

export {
  classifyMessage,
  CLASSIFY_SYSTEM_PROMPT,
  type ClassifyOptions,
  type ClassifyResult,
  type EntityHints,
} from './classify.js';

export {
  parseClaim,
  PARSE_SYSTEM_PROMPT,
  PARSE_TOOLS,
  SEARCH_FIXTURES_TOOL,
  RESOLVE_PLAYER_TOOL,
  GET_MARKET_MENU_TOOL,
  SUBMIT_PARSE_TOOL,
  type FixtureSearchResult,
  type MarketMenuEntry,
  type ParseOptions,
  type ParseToolExecutors,
  type PlayerResolveResult,
} from './parse.js';

export {
  persona,
  createGarnishBudget,
  GARNISH_SYSTEM_PROMPT,
  type GarnishBudget,
  type PersonaOptions,
} from './persona.js';

export {
  PERSONA_TEMPLATE_KEYS,
  PERSONA_TEMPLATES,
  renderTemplate,
  selectTemplate,
  type PersonaTemplateKey,
  type PersonaVars,
} from './templates.js';

export {
  DENY_LIST_PATTERNS,
  violatesDenyList,
  type DenyListPattern,
  type DenyListViolation,
} from './denylist.js';

export {
  goldenSet,
  goldenFixtures,
  goldenPlayers,
  goldenEntities,
  makeGoldenContext,
  makeGoldenExecutors,
  GOLDEN_NOW_MS,
  type GoldenFixture,
  type GoldenFixtureInfo,
  type GoldenPlayerInfo,
  type GoldenTag,
} from './goldenSet.js';
