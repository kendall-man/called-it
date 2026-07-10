import {
  arrayField,
  booleanField,
  integerField,
  isRoutingDecision,
  isUpdateState,
  isUuid,
  objectField,
  record,
  stringField,
} from './telegram-db-core.js';
import { parseAction, parseCode } from './telegram-db-parser-core.js';
import { malformedTelegramRpcResponse } from './telegram-db-rpc-response.js';
import type {
  TelegramActionResult,
  TelegramDbCode,
  TelegramLeaseUpdateItem,
  TelegramPersistResult,
  TelegramUpdateState,
} from './telegram-types.js';

export function parsePersistResult(
  op: string,
  payload: unknown,
): TelegramPersistResult | { readonly ok: false; readonly code: TelegramDbCode } {
  const row = record(op, payload);
  if (!booleanField(op, row, 'ok')) {
    return { ok: false, code: parseCode(op, row) };
  }

  const state = stringField(op, row, 'state');
  const routingDecision = stringField(op, row, 'routing_decision');
  if (!isUpdateState(state) || !isRoutingDecision(routingDecision) || !isUuid(row.id)) {
    return malformedTelegramRpcResponse(op);
  }
  return {
    ok: true,
    id: row.id,
    routingDecision,
    state,
    duplicate: booleanField(op, row, 'duplicate'),
  };
}

export function parseLeaseUpdates(op: string, payload: unknown): readonly TelegramLeaseUpdateItem[] {
  const row = record(op, payload);
  if (!booleanField(op, row, 'ok')) {
    return malformedTelegramRpcResponse(op);
  }

  return arrayField(op, row, 'items').map((item) => {
    const entry = record(op, item);
    const state = stringField(op, entry, 'state');
    const routingDecision = stringField(op, entry, 'routing_decision');
    const updatePayload = objectField(op, entry, 'payload');
    if (!isUuid(entry.id) || state !== 'leased' || !isRoutingDecision(routingDecision)) {
      return malformedTelegramRpcResponse(op);
    }
    return {
      id: entry.id,
      telegramUpdateId: integerField(op, entry, 'telegram_update_id'),
      updateType: stringField(op, entry, 'update_type'),
      routingDecision,
      state,
      attempts: integerField(op, entry, 'attempts'),
      sourceFingerprint: stringField(op, entry, 'source_fingerprint'),
      payload: updatePayload,
      leaseExpiresAt: stringField(op, entry, 'lease_expires_at'),
    };
  });
}

export function parseUpdateAction(
  op: string,
  payload: unknown,
): TelegramActionResult<TelegramUpdateState> {
  return parseAction(op, payload, isUpdateState);
}
