import { z } from 'zod';
import type { ServerResponse } from 'node:http';
import type { Logger } from '../log.js';
import { sendJson } from './server-http.js';

const POSITION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SOLANA_PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_TRANSACTION_PATTERN = /^[A-Za-z0-9+/]{1,4094}={0,2}$/;
const SOLANA_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;
const REJECTION_CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

export const EscrowPositionAcceptInputSchema = z.object({
  token: z.string().regex(POSITION_TOKEN_PATTERN),
  telegramUserId: z.number().int().positive().safe(),
  privyUserId: z.string().min(1).max(255),
  privyWalletId: z.string().min(1).max(255),
  ownerPubkey: z.string().regex(SOLANA_PUBKEY_PATTERN),
  marketId: z.string().regex(UUID_PATTERN),
  rawTransactionBase64: z.string().max(4096).regex(BASE64_TRANSACTION_PATTERN),
}).strict();

export interface EscrowPositionAcceptInput {
  readonly token: string;
  readonly telegramUserId: number;
  readonly privyUserId: string;
  readonly privyWalletId: string;
  readonly ownerPubkey: string;
  readonly marketId: string;
  readonly rawTransactionBase64: string;
}

export type EscrowPositionAcceptResult =
  | {
      readonly kind: 'accepted';
      readonly duplicate: boolean;
      readonly jobCreated: boolean;
      readonly signature: string;
    }
  | { readonly kind: 'rejected'; readonly code: string };

export interface EscrowPositionAcceptApi {
  accept(input: EscrowPositionAcceptInput): Promise<EscrowPositionAcceptResult>;
}

const EscrowPositionAcceptResultSchema = z.union([
  z.object({
    kind: z.literal('accepted'),
    duplicate: z.boolean(),
    jobCreated: z.boolean(),
    signature: z.string().regex(SOLANA_SIGNATURE_PATTERN),
  }).strict(),
  z.object({
    kind: z.literal('rejected'),
    code: z.string().regex(REJECTION_CODE_PATTERN),
  }).strict(),
]);

function rejectedStatus(code: string): number {
  switch (code) {
    case 'invalid_input':
      return 400;
    case 'session_not_found':
      return 404;
    case 'temporarily_unavailable':
      return 503;
    default:
      return 409;
  }
}

export async function handleEscrowPositionAccept(input: {
  readonly body: unknown;
  readonly custodyMode: 'legacy' | 'escrow';
  readonly api: EscrowPositionAcceptApi | undefined;
  readonly log: Logger;
  readonly res: ServerResponse;
}): Promise<void> {
  if (input.custodyMode !== 'escrow') {
    sendJson(input.res, 409, { kind: 'rejected', code: 'unavailable_mode' });
    return;
  }
  if (input.api === undefined) {
    sendJson(input.res, 503, { kind: 'rejected', code: 'temporarily_unavailable' });
    return;
  }
  const parsed = EscrowPositionAcceptInputSchema.safeParse(input.body);
  if (!parsed.success) {
    sendJson(input.res, 400, { kind: 'rejected', code: 'invalid_input' });
    return;
  }
  try {
    const result = EscrowPositionAcceptResultSchema.safeParse(await input.api.accept(parsed.data));
    if (!result.success) {
      input.log.error('escrow_position_accept_invalid_response');
      sendJson(input.res, 503, { kind: 'rejected', code: 'temporarily_unavailable' });
      return;
    }
    if (result.data.kind === 'accepted') {
      sendJson(input.res, 202, result.data);
      return;
    }
    sendJson(input.res, rejectedStatus(result.data.code), result.data);
  } catch (error) {
    input.log.warn('escrow_position_accept_failed', {
      reason: error instanceof Error ? 'accept_exception' : 'unknown_exception',
    });
    sendJson(input.res, 503, { kind: 'rejected', code: 'temporarily_unavailable' });
  }
}
