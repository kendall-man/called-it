/**
 * Minimal structural interface over the Anthropic Messages API.
 *
 * Everything in this package talks to the model through this interface so
 * tests can inject scripted fakes (no live API in CI) and the engine can
 * inject one shared real client. `createAnthropicClient` adapts the official
 * SDK to it for live use.
 */

import Anthropic from '@anthropic-ai/sdk';

export interface ModelToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ModelTextBlock = { type: 'text'; text: string };

export type ModelToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};

export type ModelContentBlock = ModelTextBlock | ModelToolUseBlock;

export type ModelToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export interface ModelMessageParam {
  role: 'user' | 'assistant';
  content: string | Array<ModelContentBlock | ModelToolResultBlock>;
}

export type ModelToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

export interface ModelRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: ModelMessageParam[];
  tools?: ModelToolDefinition[];
  tool_choice?: ModelToolChoice;
}

export interface ModelResponse {
  content: ModelContentBlock[];
  stop_reason?: string | null;
}

/** The injectable seam: anything with `messages.create` of this shape. */
export interface AgentModelClient {
  messages: {
    create(request: ModelRequest): Promise<ModelResponse>;
  };
}

/**
 * Wrap the official SDK client in the narrow AgentModelClient surface.
 * Reads ANTHROPIC_API_KEY from the environment when no key is passed.
 * Never constructed in CI — tests inject fakes instead.
 */
export function createAnthropicClient(options: { apiKey?: string } = {}): AgentModelClient {
  const sdk = new Anthropic(options.apiKey !== undefined ? { apiKey: options.apiKey } : {});
  return {
    messages: {
      async create(request: ModelRequest): Promise<ModelResponse> {
        // The request shape is a strict subset of the SDK's non-streaming
        // params; the response is narrowed to the blocks we consume.
        const response = await sdk.messages.create(
          request as unknown as Parameters<typeof sdk.messages.create>[0],
        );
        return response as unknown as ModelResponse;
      },
    },
  };
}

/** Concatenate all text blocks of a response into one string. */
export function responseText(response: ModelResponse): string {
  return response.content
    .filter((block): block is ModelTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
