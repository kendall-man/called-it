/**
 * Minimal structural interface over the Anthropic Messages API.
 *
 * Everything in this package talks to the model through this interface so
 * tests can inject scripted fakes (no live API in CI) and the engine can
 * inject one shared real client. `createModelClient` adapts the official
 * Anthropic SDK for live use, pointed at GLM (Z.ai) by default.
 *
 * GLM speaks the Anthropic Messages wire format — system/messages/tools/
 * tool_choice in, `tool_use` content blocks out — so the SDK drives it
 * unchanged once its base URL is repointed.
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
 * GLM (Z.ai) Anthropic-compatible endpoint. The SDK appends `/v1/messages`.
 * Override per-deploy with GLM_BASE_URL (e.g. the open.bigmodel.cn mirror).
 */
export const DEFAULT_MODEL_BASE_URL = 'https://api.z.ai/api/anthropic';

/**
 * Wrap the official Anthropic SDK in the narrow AgentModelClient surface,
 * pointed at GLM by default. Key and base URL each resolve independently:
 * explicit option → GLM_* env var → (key only) legacy ANTHROPIC_API_KEY →
 * (base URL only) the built-in GLM default.
 * Never constructed in CI — tests inject fakes instead.
 */
export function createModelClient(
  options: { apiKey?: string; baseURL?: string } = {},
): AgentModelClient {
  const apiKey = options.apiKey ?? process.env.GLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const baseURL = options.baseURL ?? process.env.GLM_BASE_URL ?? DEFAULT_MODEL_BASE_URL;
  const sdk = new Anthropic({ baseURL, ...(apiKey !== undefined ? { apiKey } : {}) });
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
