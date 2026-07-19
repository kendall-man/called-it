import { z } from 'zod';
import {
  EngineAcceptResponseSchema,
  PositionAuthorizationSchema,
  type EscrowAccountPosition,
  type PositionAuthorization,
  type PositionIndexedStatus,
} from './position-contract';

const SessionSchema = z.object({
  jwt: z.string().min(16),
  expiresAt: z.string().datetime({ offset: true }),
  network: z.enum(['devnet', 'mainnet-beta']),
}).strict();

const PreparedSchema = z.object({
  kind: z.literal('prepared'),
  rawTransactionBase64: z.string().min(4).max(4096),
  authorization: PositionAuthorizationSchema,
  terms: z.object({
    title: z.string().min(1).max(240),
    choice: z.enum(['It happens', 'It does not']),
    side: z.enum(['back', 'doubt']),
    asset: z.enum(['sol', 'usdc']),
    amountAtomic: z.string().regex(/^[1-9]\d{0,19}$/),
  }).strict(),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

const StatusSchema = z.object({
  stage: z.enum(['awaiting_signature', 'confirming', 'finalized', 'unknown_confirmation', 'approval_lapsed']),
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,128}$/).nullable(),
  positionState: z.enum(['pending', 'active', 'invalidated', 'refundable', 'claimed']).nullable(),
  commitment: z.enum(['confirmed', 'finalized']).nullable(),
}).strict();

const EscrowPositionSchema = z.object({
  marketId: z.string().uuid(),
  side: z.enum(['back', 'doubt']),
  asset: z.enum(['sol', 'usdc']),
  depositedAtomic: z.string().regex(/^\d+$/),
  pendingAtomic: z.string().regex(/^\d+$/),
  activeAtomic: z.string().regex(/^\d+$/),
  refundableAtomic: z.string().regex(/^\d+$/),
  claimedAtomic: z.string().regex(/^\d+$/),
  chainState: z.string().min(1).max(32),
  replay: z.boolean(),
  claimState: z.enum(['open', 'pending', 'checking', 'ready', 'claimed']),
}).strict();

const AccountSchema = z.object({ positions: z.array(EscrowPositionSchema) }).strict();
const ErrorSchema = z.object({ error: z.string().min(1).max(100) }).passthrough();
const REQUEST_TIMEOUT_MS = 15_000;

export class PositionClientError extends Error {
  readonly name = 'PositionClientError';

  constructor(readonly code: string) {
    super(code);
  }
}

export type PreparedPosition = {
  readonly rawTransactionBase64: string;
  readonly authorization: PositionAuthorization;
  readonly terms: {
    readonly title: string;
    readonly choice: 'It happens' | 'It does not';
    readonly side: 'back' | 'doubt';
    readonly asset: 'sol' | 'usdc';
    readonly amountAtomic: string;
  };
  readonly expiresAt: string;
};

export async function requestPositionAuthSession(token: string, initData: string) {
  if (initData.length === 0) throw new PositionClientError('telegram_auth_required');
  const body = await apiRequest('/api/position/session', { token, initData });
  const parsed = SessionSchema.safeParse(body);
  if (!parsed.success) throw new PositionClientError(responseError(body));
  return parsed.data;
}

export async function requestPreparedPosition(input: {
  readonly token: string;
  readonly accessToken: string;
  readonly pubkey: string;
}): Promise<PreparedPosition> {
  const body = await apiRequest('/api/position/prepare', {
    token: input.token,
    pubkey: input.pubkey,
  }, input.accessToken);
  const parsed = PreparedSchema.safeParse(body);
  if (!parsed.success) throw new PositionClientError(responseError(body));
  return parsed.data;
}

export async function submitSignedPosition(input: {
  readonly token: string;
  readonly accessToken: string;
  readonly pubkey: string;
  readonly rawTransactionBase64: string;
}) {
  const body = await apiRequest('/api/position/submit', {
    token: input.token,
    pubkey: input.pubkey,
    rawTransactionBase64: input.rawTransactionBase64,
  }, input.accessToken);
  const parsed = EngineAcceptResponseSchema.safeParse(body);
  if (!parsed.success) throw new PositionClientError(responseError(body));
  if (parsed.data.kind !== 'accepted') throw new PositionClientError(parsed.data.code);
  return parsed.data;
}

export async function requestPositionStatus(input: {
  readonly token: string;
  readonly accessToken: string;
  readonly pubkey: string;
}): Promise<PositionIndexedStatus> {
  const body = await apiRequest('/api/position/status', {
    token: input.token,
    pubkey: input.pubkey,
  }, input.accessToken);
  const parsed = StatusSchema.safeParse(body);
  if (!parsed.success) throw new PositionClientError(responseError(body));
  return parsed.data;
}

export async function requestEscrowAccountPositions(
  accessToken: string,
  pubkey: string,
): Promise<readonly EscrowAccountPosition[]> {
  const body = await apiRequest('/api/position/account', { pubkey }, accessToken);
  const parsed = AccountSchema.safeParse(body);
  if (!parsed.success) throw new PositionClientError(responseError(body));
  return parsed.data.positions;
}

async function apiRequest(
  path: string,
  body: Readonly<Record<string, unknown>>,
  accessToken?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    throw new PositionClientError('rpc_unavailable');
  } finally {
    globalThis.clearTimeout(timeout);
  }
  let value: unknown;
  try { value = await response.json(); } catch { value = null; }
  if (!response.ok) throw new PositionClientError(responseError(value));
  return value;
}

function responseError(value: unknown): string {
  const parsed = ErrorSchema.safeParse(value);
  return parsed.success ? parsed.data.error : 'sponsor_unavailable';
}
