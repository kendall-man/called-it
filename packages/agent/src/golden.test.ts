/**
 * Golden-set harness.
 *
 * CI mode (default): NO live API calls. The prefilter runs for real; the
 * parse loop runs against a scripted client that behaves like a grounded
 * model (search → submit), which exercises the full parseClaim plumbing —
 * forced tool use, executor wiring, validation, null-normalization — and
 * asserts RawClaimParse equality against expectations.
 *
 * Live mode (AGENT_LIVE=1, needs ANTHROPIC_API_KEY): the same expectations
 * run against the real models; this gates prompt changes.
 */

import { describe, expect, it } from 'vitest';
import { classifyMessage } from './classify.js';
import { createAnthropicClient } from './client.js';
import {
  goldenEntities,
  goldenSet,
  makeGoldenContext,
  makeGoldenExecutors,
  type GoldenFixture,
} from './goldenSet.js';
import { parseClaim, SEARCH_FIXTURES_TOOL, SUBMIT_PARSE_TOOL } from './parse.js';
import { prefilter } from './prefilter.js';
import { makeScriptedClient, makeTextClient, toolUseBlock } from './test-helpers.js';

const DEFAULT_CONTEXT_FIXTURE = 9101;

const claims = goldenSet.filter(
  (f): f is GoldenFixture & { expected: NonNullable<GoldenFixture['expected']> } =>
    f.expected !== null,
);
const classifierRejects = goldenSet.filter((f) => f.tags?.includes('needs_classifier'));

function contextFor(fixture: GoldenFixture) {
  return makeGoldenContext(fixture.contextFixtureId ?? DEFAULT_CONTEXT_FIXTURE);
}

describe('golden set shape', () => {
  it('has at least 50 fixtures with slang, typos and non-claims', () => {
    expect(goldenSet.length).toBeGreaterThanOrEqual(50);
    expect(goldenSet.some((f) => f.tags?.includes('slang'))).toBe(true);
    expect(goldenSet.some((f) => f.tags?.includes('typo'))).toBe(true);
    expect(goldenSet.filter((f) => f.expected === null).length).toBeGreaterThanOrEqual(15);
  });

  it('every expected parse stays inside the closed taxonomy', () => {
    for (const { expected } of claims) {
      expect(expected.claimType).not.toBeNull();
      expect(expected.fixtureId).not.toBeNull();
    }
  });
});

describe('golden harness — prefilter + mock parser (no LLM calls)', () => {
  it.each(claims.map((f) => [f.text, f] as const))(
    'parses through the tool loop: %s',
    async (_text, fixture) => {
      // Stage 1: the deterministic gate must let the claim through.
      expect(prefilter(fixture.text, goldenEntities)).toBe(true);

      // Stage 2: scripted grounded model — searches first, then submits.
      const client = makeScriptedClient([
        {
          content: [toolUseBlock(SEARCH_FIXTURES_TOOL, { query: fixture.text }, 'tu_search')],
          stop_reason: 'tool_use',
        },
        {
          content: [toolUseBlock(SUBMIT_PARSE_TOOL, fixture.expected, 'tu_submit')],
          stop_reason: 'tool_use',
        },
      ]);
      const result = await parseClaim(fixture.text, contextFor(fixture), {
        client,
        executors: makeGoldenExecutors(),
      });

      // Asserts compiled-shape equality, not raw LLM text (PRD testing rule).
      expect(result).toEqual(fixture.expected);
      // The loop really did ground through a tool round before submitting.
      expect(client.requests).toHaveLength(2);
      expect(client.requests.every((r) => r.tool_choice?.type === 'any')).toBe(true);
    },
  );

  it.each(classifierRejects.map((f) => [f.text] as const))(
    'classifier stage can reject prefilter survivors: %s',
    async (text) => {
      expect(prefilter(text, goldenEntities)).toBe(true);
      const client = makeTextClient(
        '{"is_claim": false, "confidence": 0.2, "claim_type_guess": null}',
      );
      const verdict = await classifyMessage(text, goldenEntities, { client });
      expect(verdict.isClaim).toBe(false);
    },
  );
});

const LIVE = process.env.AGENT_LIVE === '1';
const LIVE_TEST_TIMEOUT_MS = 90_000;

describe.runIf(LIVE)('golden harness — LIVE models (AGENT_LIVE=1)', () => {
  const client = LIVE ? createAnthropicClient() : undefined;

  it.each(claims.map((f) => [f.text, f] as const))(
    'live parse: %s',
    async (_text, fixture) => {
      const result = await parseClaim(fixture.text, contextFor(fixture), {
        client: client!,
        executors: makeGoldenExecutors(),
      });
      expect(result).toEqual(fixture.expected);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it.each(claims.map((f) => [f.text] as const))(
    'live classify flags the claim: %s',
    async (text) => {
      const verdict = await classifyMessage(text, goldenEntities, { client: client! });
      expect(verdict.isClaim).toBe(true);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it.each(classifierRejects.map((f) => [f.text] as const))(
    'live classify rejects: %s',
    async (text) => {
      const verdict = await classifyMessage(text, goldenEntities, { client: client! });
      // Reject means: never confident enough to price a nudge.
      expect(verdict.isClaim === false || verdict.confidence < 0.85).toBe(true);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
