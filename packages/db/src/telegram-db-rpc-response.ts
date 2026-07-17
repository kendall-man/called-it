import { DbError } from './errors.js';
import type { TelegramDbClient } from './telegram-db-core.js';

export type TelegramRpcPayloadParser<T> = (op: string, payload: unknown) => T;

interface TelegramRpcCall<T> {
  readonly op: string;
  readonly args: Record<string, unknown>;
  readonly parse: TelegramRpcPayloadParser<T>;
}

interface TelegramRpcResponse {
  readonly data: unknown;
  readonly error: unknown;
}

export async function invokeTelegramRpc<T>(
  client: TelegramDbClient,
  call: TelegramRpcCall<T>,
): Promise<T> {
  const response: unknown = await client.rpc(call.op, call.args);
  if (!isTelegramRpcResponse(response) || response.error !== null || response.data === null) {
    return malformedTelegramRpcResponse(call.op);
  }

  try {
    return call.parse(call.op, response.data);
  } catch (error) {
    if (error instanceof DbError) {
      return malformedTelegramRpcResponse(call.op);
    }
    throw error;
  }
}

export function malformedTelegramRpcResponse(op: string): never {
  throw new DbError(op, { message: 'malformed RPC response' });
}

function isTelegramRpcResponse(value: unknown): value is TelegramRpcResponse {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'data' in value && 'error' in value;
}
