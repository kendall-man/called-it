/**
 * Scripted AgentModelClient fakes for CI — no live API calls ever happen in
 * tests (live mode is opt-in behind AGENT_LIVE=1 in golden.test.ts).
 */

import type {
  AgentModelClient,
  ModelContentBlock,
  ModelRequest,
  ModelResponse,
} from './client.js';

export interface ScriptedClient extends AgentModelClient {
  /** Every request the fake received, in order. */
  requests: ModelRequest[];
}

/** A client that replays a fixed sequence of responses (repeats the last). */
export function makeScriptedClient(script: readonly ModelResponse[]): ScriptedClient {
  const requests: ModelRequest[] = [];
  let cursor = 0;
  return {
    requests,
    messages: {
      async create(request: ModelRequest): Promise<ModelResponse> {
        requests.push(request);
        const response = script[Math.min(cursor, script.length - 1)];
        cursor += 1;
        if (!response) throw new Error('scripted client has no responses');
        return response;
      },
    },
  };
}

/** A client whose every response is a single text block. */
export function makeTextClient(text: string): ScriptedClient {
  return makeScriptedClient([{ content: [textBlock(text)], stop_reason: 'end_turn' }]);
}

export function textBlock(text: string): ModelContentBlock {
  return { type: 'text', text };
}

export function toolUseBlock(name: string, input: unknown, id = `tu_${name}`): ModelContentBlock {
  return { type: 'tool_use', id, name, input };
}
