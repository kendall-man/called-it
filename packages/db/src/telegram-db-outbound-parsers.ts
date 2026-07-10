import {
  arrayField,
  booleanField,
  integerField,
  isOutboundState,
  isUuid,
  record,
  stringField,
} from './telegram-db-core.js';
import { parseAction, parseCode } from './telegram-db-parser-core.js';
import { malformedTelegramRpcResponse } from './telegram-db-rpc-response.js';
import type {
  TelegramActionResult,
  TelegramDbCode,
  TelegramLeaseCompletionItem,
  TelegramLeaseOwnershipItem,
  TelegramOutboundState,
  TelegramPlanOutboundResult,
  TelegramResolveOwnedMessageResult,
  TelegramStartOutboundResult,
} from './telegram-types.js';

export function parsePlanOutbound(
  op: string,
  payload: unknown,
): TelegramPlanOutboundResult | { readonly ok: false; readonly code: TelegramDbCode } {
  const row = record(op, payload);
  if (!booleanField(op, row, 'ok')) {
    return { ok: false, code: parseCode(op, row) };
  }

  const state = stringField(op, row, 'state');
  if (!isUuid(row.id) || !isOutboundState(state)) {
    return malformedTelegramRpcResponse(op);
  }
  return {
    ok: true,
    id: row.id,
    state,
    chatId: integerField(op, row, 'chat_id'),
    domainKind: stringField(op, row, 'domain_kind'),
    domainId: stringField(op, row, 'domain_id'),
    duplicate: booleanField(op, row, 'duplicate'),
  };
}

export function parseStartOutbound(
  op: string,
  payload: unknown,
): TelegramStartOutboundResult | { readonly ok: false; readonly code: TelegramDbCode } {
  const row = record(op, payload);
  if (!booleanField(op, row, 'ok')) {
    return { ok: false, code: parseCode(op, row) };
  }
  if (!isUuid(row.id) || stringField(op, row, 'state') !== 'sending') {
    return malformedTelegramRpcResponse(op);
  }
  return {
    ok: true,
    id: row.id,
    state: 'sending',
    chatId: integerField(op, row, 'chat_id'),
    domainKind: stringField(op, row, 'domain_kind'),
    domainId: stringField(op, row, 'domain_id'),
    leaseExpiresAt: stringField(op, row, 'lease_expires_at'),
  };
}

export function parseOutboundAction(
  op: string,
  payload: unknown,
): TelegramActionResult<TelegramOutboundState> {
  return parseAction(op, payload, isOutboundState);
}

export function parseCount(op: string, payload: unknown): number {
  const row = record(op, payload);
  if (!booleanField(op, row, 'ok')) {
    return malformedTelegramRpcResponse(op);
  }
  return integerField(op, row, 'count');
}

export function parseLeaseOwnership(
  op: string,
  payload: unknown,
): readonly TelegramLeaseOwnershipItem[] {
  const row = record(op, payload);
  if (!booleanField(op, row, 'ok')) {
    return malformedTelegramRpcResponse(op);
  }

  return arrayField(op, row, 'items').map((item) => {
    const entry = record(op, item);
    if (!isUuid(entry.id) || stringField(op, entry, 'state') !== 'ownership_uncertain') {
      return malformedTelegramRpcResponse(op);
    }
    return {
      id: entry.id,
      chatId: integerField(op, entry, 'chat_id'),
      domainKind: stringField(op, entry, 'domain_kind'),
      domainId: stringField(op, entry, 'domain_id'),
      state: 'ownership_uncertain',
      reconcileAttempts: integerField(op, entry, 'reconcile_attempts'),
      leaseExpiresAt: stringField(op, entry, 'lease_expires_at'),
    };
  });
}

export function parseLeaseCompletion(
  op: string,
  payload: unknown,
): readonly TelegramLeaseCompletionItem[] {
  const row = exactRecord(op, payload, ['ok', 'items']);
  if (!booleanField(op, row, 'ok')) {
    return malformedTelegramRpcResponse(op);
  }

  return arrayField(op, row, 'items').map((item) => {
    const entry = exactRecord(op, item, [
      'id',
      'chat_id',
      'domain_kind',
      'domain_id',
      'state',
      'telegram_message_id',
      'lease_expires_at',
    ]);
    const state = stringField(op, entry, 'state');
    if (!isUuid(entry.id) || (state !== 'owned' && state !== 'reconciled')) {
      return malformedTelegramRpcResponse(op);
    }
    return {
      id: entry.id,
      chatId: integerField(op, entry, 'chat_id'),
      domainKind: stringField(op, entry, 'domain_kind'),
      domainId: stringField(op, entry, 'domain_id'),
      state,
      telegramMessageId: integerField(op, entry, 'telegram_message_id'),
      leaseExpiresAt: stringField(op, entry, 'lease_expires_at'),
    };
  });
}

export function parseResolveOwnedMessage(
  op: string,
  payload: unknown,
): TelegramResolveOwnedMessageResult {
  const row = record(op, payload);
  if (!booleanField(op, row, 'ok')) {
    return { ok: false, code: parseCode(op, row) };
  }

  const owner = stringField(op, row, 'owner');
  if (owner === 'unknown') {
    return { ok: true, owner };
  }
  if (owner === 'engine' && isUuid(row.job_id)) {
    return {
      ok: true,
      owner,
      jobId: row.job_id,
      domainKind: stringField(op, row, 'domain_kind'),
      domainId: stringField(op, row, 'domain_id'),
    };
  }
  return malformedTelegramRpcResponse(op);
}

function exactRecord(
  op: string,
  payload: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const value = record(op, payload);
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key) => !expectedKeys.includes(key))
  ) {
    return malformedTelegramRpcResponse(op);
  }
  return value;
}
