import {
  booleanField,
  isTelegramDbCode,
  isUuid,
  record,
  stringField,
} from './telegram-db-core.js';
import { malformedTelegramRpcResponse } from './telegram-db-rpc-response.js';
import type { TelegramActionResult, TelegramDbCode } from './telegram-types.js';

export function parseAction<S extends string>(
  op: string,
  payload: unknown,
  isState: (value: unknown) => value is S,
): TelegramActionResult<S> {
  const row = record(op, payload);
  if (!booleanField(op, row, 'ok')) {
    const code = parseCode(op, row);
    if (!('state' in row)) {
      return { ok: false, code };
    }
    if (!isState(row.state)) {
      return malformedTelegramRpcResponse(op);
    }
    return { ok: false, code, state: row.state };
  }

  const state = stringField(op, row, 'state');
  if (!isUuid(row.id) || !isState(state)) {
    return malformedTelegramRpcResponse(op);
  }
  return { ok: true, id: row.id, state, duplicate: booleanField(op, row, 'duplicate') };
}

export function parseCode(
  op: string,
  row: Readonly<Record<string, unknown>>,
): TelegramDbCode {
  const code = row.code;
  if (isTelegramDbCode(code)) {
    return code;
  }
  return malformedTelegramRpcResponse(op);
}
