import { describe, expect, it, vi } from 'vitest';
import type { RawClaimParse } from '@calledit/market-engine';
import { PARSER_MODEL } from './constants.js';
import { AgentParseError, AgentResponseFormatError } from './errors.js';
import {
  GET_MARKET_MENU_TOOL,
  RESOLVE_PLAYER_TOOL,
  SEARCH_FIXTURES_TOOL,
  SUBMIT_PARSE_TOOL,
  parseClaim,
  type ParseToolExecutors,
} from './parse.js';
import { makeGoldenContext, makeGoldenExecutors } from './goldenSet.js';
import { makeScriptedClient, textBlock, toolUseBlock } from './test-helpers.js';

const ctx = makeGoldenContext(9101);

const fullParse: RawClaimParse = {
  claimType: 'player_scores_n',
  fixtureId: 9101,
  entityName: 'Kylian Mbappé',
  entityKind: 'player',
  comparator: 'gte',
  threshold: 2,
  period: null,
  unresolved: null,
};

describe('parseClaim tool loop', () => {
  it('runs grounded tools then returns the submitted parse', async () => {
    const client = makeScriptedClient([
      {
        content: [
          toolUseBlock(SEARCH_FIXTURES_TOOL, { query: 'france' }, 'tu_1'),
          toolUseBlock(RESOLVE_PLAYER_TOOL, { name: 'mbappe' }, 'tu_2'),
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [toolUseBlock(SUBMIT_PARSE_TOOL, fullParse, 'tu_3')],
        stop_reason: 'tool_use',
      },
    ]);
    const executors = makeGoldenExecutors();
    const searchSpy = vi.spyOn(executors, 'searchFixtures');
    const resolveSpy = vi.spyOn(executors, 'resolvePlayer');

    const result = await parseClaim('mbappe bags a brace', ctx, { client, executors });

    expect(result).toEqual(fullParse);
    expect(searchSpy).toHaveBeenCalledWith('france');
    expect(resolveSpy).toHaveBeenCalledWith('mbappe');

    // Round 2 must carry the tool results back to the model.
    expect(client.requests).toHaveLength(2);
    const secondRequest = JSON.stringify(client.requests[1]!.messages);
    expect(secondRequest).toContain('tool_result');
    expect(secondRequest).toContain('Kylian Mbapp');
  });

  it('forces tool use on every round with the pinned parser model', async () => {
    const client = makeScriptedClient([
      { content: [toolUseBlock(SUBMIT_PARSE_TOOL, fullParse)], stop_reason: 'tool_use' },
    ]);
    await parseClaim('x', ctx, { client, executors: makeGoldenExecutors() });
    const request = client.requests[0]!;
    expect(request.model).toBe(PARSER_MODEL);
    expect(request.tool_choice).toEqual({ type: 'any' });
    expect(request.tools?.map((t) => t.name)).toEqual([
      SEARCH_FIXTURES_TOOL,
      RESOLVE_PLAYER_TOOL,
      GET_MARKET_MENU_TOOL,
      SUBMIT_PARSE_TOOL,
    ]);
  });

  it('normalizes omitted submit_parse fields to nulls', async () => {
    const client = makeScriptedClient([
      {
        content: [toolUseBlock(SUBMIT_PARSE_TOOL, { claimType: 'btts', fixtureId: 9101 })],
        stop_reason: 'tool_use',
      },
    ]);
    const result = await parseClaim('btts tonight', ctx, {
      client,
      executors: makeGoldenExecutors(),
    });
    expect(result).toEqual({
      claimType: 'btts',
      fixtureId: 9101,
      entityName: null,
      entityKind: null,
      comparator: null,
      threshold: null,
      period: null,
      unresolved: null,
    });
  });

  it('rejects a submit_parse with an out-of-taxonomy claim type', async () => {
    const client = makeScriptedClient([
      {
        content: [toolUseBlock(SUBMIT_PARSE_TOOL, { claimType: 'first_goalscorer' })],
        stop_reason: 'tool_use',
      },
    ]);
    await expect(
      parseClaim('kane first', ctx, { client, executors: makeGoldenExecutors() }),
    ).rejects.toBeInstanceOf(AgentResponseFormatError);
  });

  it('feeds executor failures back as is_error tool results and continues', async () => {
    const failing: ParseToolExecutors = {
      ...makeGoldenExecutors(),
      async searchFixtures() {
        throw new Error('db unavailable');
      },
    };
    const client = makeScriptedClient([
      { content: [toolUseBlock(SEARCH_FIXTURES_TOOL, { query: 'france' })], stop_reason: 'tool_use' },
      { content: [toolUseBlock(SUBMIT_PARSE_TOOL, fullParse)], stop_reason: 'tool_use' },
    ]);
    const result = await parseClaim('x', ctx, { client, executors: failing });
    expect(result).toEqual(fullParse);
    const secondRequest = JSON.stringify(client.requests[1]!.messages);
    expect(secondRequest).toContain('is_error');
    expect(secondRequest).toContain('db unavailable');
  });

  it('gives up with AgentParseError when the model never submits', async () => {
    const client = makeScriptedClient([
      { content: [toolUseBlock(SEARCH_FIXTURES_TOOL, { query: 'x' })], stop_reason: 'tool_use' },
    ]);
    await expect(
      parseClaim('x', ctx, { client, executors: makeGoldenExecutors(), maxToolRounds: 3 }),
    ).rejects.toBeInstanceOf(AgentParseError);
    expect(client.requests).toHaveLength(3);
  });

  it('errors when forced tool use is violated (text-only response)', async () => {
    const client = makeScriptedClient([
      { content: [textBlock('I think this is a match winner claim')], stop_reason: 'end_turn' },
    ]);
    await expect(
      parseClaim('x', ctx, { client, executors: makeGoldenExecutors() }),
    ).rejects.toBeInstanceOf(AgentParseError);
  });

  it('describes the active fixture and known players in the prompt', async () => {
    const client = makeScriptedClient([
      { content: [toolUseBlock(SUBMIT_PARSE_TOOL, fullParse)], stop_reason: 'tool_use' },
    ]);
    await parseClaim('mbappe scores', ctx, { client, executors: makeGoldenExecutors() });
    const firstUser = JSON.stringify(client.requests[0]!.messages[0]);
    expect(firstUser).toContain('France vs Brazil');
    expect(firstUser).toContain('Kylian Mbapp');
  });
});
