import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadWebEnv } from './env';
import {
  parseMiniAppPositionStartParam,
  startParamFromInitData,
  telegramUsernameFromInitData,
  type MiniAppAmountCode,
  type MiniAppPositionSide,
} from './miniapp-contract';
import { verifyTelegramInitData as verifyTelegramWebAppInitData } from './telegram-init-data-server';

export interface MiniAppApiResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export type MiniAppServerConfig = {
  readonly custodyMode: 'legacy' | 'escrow';
  readonly engineToken: string;
  readonly engineUrl: string;
  readonly telegramBotToken: string;
};

export type MiniAppServerDependencies = {
  readonly config?: MiniAppServerConfig;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly verifyTelegramInitData?: (
    initData: string,
    now: Date,
  ) => { readonly telegramUserId: number };
};

const OpenRequestSchema = z.object({
  initData: z.string().min(1).max(8_192),
}).strict();

const EngineSessionSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAtIso: z.string().datetime({ offset: true }),
});

const EngineErrorSchema = z.object({ error: z.string().min(1).max(80) });

const ENGINE_TIMEOUT_MS = 15_000;
// Re-opens inside one bucket reuse the same engine session instead of minting
// unbounded ones; the bucket width is part of the shared web/engine contract.
const IDEMPOTENCY_BUCKET_SECONDS = 30;

const POSITION_OPEN_ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request: 400,
  market_not_found: 404,
  wallet_required: 409,
  positions_paused: 409,
  market_closed: 410,
  rate_limited: 429,
};

const WALLET_OPEN_ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request: 400,
  rate_limited: 429,
};

export function miniAppPositionIdempotencyKey(input: {
  readonly telegramUserId: number;
  readonly marketId: string;
  readonly side: MiniAppPositionSide;
  readonly amountCode: MiniAppAmountCode;
  readonly now: Date;
}): string {
  const bucket = idempotencyBucket(input.now);
  // The amount code is part of the key so a re-open at a DIFFERENT rung mints a
  // distinct session rather than colliding with the previous amount's session.
  return sha256Hex(
    `miniapp:${input.telegramUserId}:${input.marketId}:${input.side}:${input.amountCode}:${bucket}`,
  );
}

export function miniAppWalletIdempotencyKey(input: {
  readonly telegramUserId: number;
  readonly now: Date;
}): string {
  const bucket = idempotencyBucket(input.now);
  return sha256Hex(`miniapp-wallet:${input.telegramUserId}:${bucket}`);
}

export async function openMiniAppPositionSession(
  raw: unknown,
  dependencies: MiniAppServerDependencies = {},
): Promise<MiniAppApiResult> {
  const input = OpenRequestSchema.safeParse(raw);
  if (!input.success) return refusal(400, 'invalid_request');
  const config = dependencies.config ?? loadMiniAppServerConfig();
  if (config.custodyMode !== 'escrow') return refusal(404, 'escrow_not_enabled');
  const now = (dependencies.now ?? (() => new Date()))();
  const verified = verifyInitData(input.data.initData, now, config, dependencies);
  if (verified === null) return refusal(401, 'telegram_auth_required');
  // The market and side come from the HMAC-signed start_param, never from
  // client-parsed request fields.
  const startParam = startParamFromInitData(input.data.initData);
  const intent = startParam === null ? null : parseMiniAppPositionStartParam(startParam);
  if (intent === null) return refusal(400, 'invalid_request');
  const telegramUsername = telegramUsernameFromInitData(input.data.initData);
  return mintEngineSession(dependencies, config, '/api/escrow/positions/session', {
    marketId: intent.marketId,
    side: intent.side,
    // The ladder amount code (base units of 0.01 SOL). Deploy the engine before
    // web: its session schema accepts both this and the legacy amountPreset.
    amountCode: intent.amountCode,
    telegramUserId: verified.telegramUserId,
    ...(telegramUsername === null ? {} : { telegramUsername }),
    idempotencyKey: miniAppPositionIdempotencyKey({
      telegramUserId: verified.telegramUserId,
      marketId: intent.marketId,
      side: intent.side,
      amountCode: intent.amountCode,
      now,
    }),
  }, POSITION_OPEN_ERROR_STATUS);
}

export async function openMiniAppWalletSession(
  raw: unknown,
  dependencies: MiniAppServerDependencies = {},
): Promise<MiniAppApiResult> {
  const input = OpenRequestSchema.safeParse(raw);
  if (!input.success) return refusal(400, 'invalid_request');
  const config = dependencies.config ?? loadMiniAppServerConfig();
  if (config.custodyMode !== 'escrow') return refusal(404, 'escrow_not_enabled');
  const now = (dependencies.now ?? (() => new Date()))();
  const verified = verifyInitData(input.data.initData, now, config, dependencies);
  if (verified === null) return refusal(401, 'telegram_auth_required');
  const telegramUsername = telegramUsernameFromInitData(input.data.initData);
  return mintEngineSession(dependencies, config, '/api/escrow/wallet/session', {
    telegramUserId: verified.telegramUserId,
    ...(telegramUsername === null ? {} : { telegramUsername }),
    idempotencyKey: miniAppWalletIdempotencyKey({
      telegramUserId: verified.telegramUserId,
      now,
    }),
  }, WALLET_OPEN_ERROR_STATUS);
}

function verifyInitData(
  initData: string,
  now: Date,
  config: MiniAppServerConfig,
  dependencies: MiniAppServerDependencies,
): { readonly telegramUserId: number } | null {
  const verifier = dependencies.verifyTelegramInitData ?? ((value: string, verifiedAt: Date) => (
    verifyTelegramWebAppInitData(value, {
      botToken: config.telegramBotToken,
      now: verifiedAt,
    })
  ));
  try {
    return verifier(initData, now);
  } catch {
    return null;
  }
}

async function mintEngineSession(
  dependencies: MiniAppServerDependencies,
  config: MiniAppServerConfig,
  path: string,
  payload: Readonly<Record<string, unknown>>,
  errorStatus: Readonly<Record<string, number>>,
): Promise<MiniAppApiResult> {
  let response: Response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(new URL(path, config.engineUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.engineToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    });
  } catch {
    return refusal(503, 'sponsor_unavailable');
  }
  const body = await safeJson(response);
  if (response.ok) {
    const session = EngineSessionSchema.safeParse(body);
    if (!session.success) return refusal(502, 'sponsor_unavailable');
    return {
      status: 200,
      body: { token: session.data.token, expiresAtIso: session.data.expiresAtIso },
    };
  }
  const engineError = EngineErrorSchema.safeParse(body);
  if (!engineError.success) return refusal(502, 'sponsor_unavailable');
  const status = errorStatus[engineError.data.error];
  if (status === undefined) return refusal(502, 'sponsor_unavailable');
  return refusal(status, engineError.data.error);
}

function loadMiniAppServerConfig(): MiniAppServerConfig {
  const env = loadWebEnv();
  if (
    env.CONCIERGE_WALLET_API_URL === undefined ||
    env.WEB_CONCIERGE_TOKEN === undefined ||
    env.TELEGRAM_BOT_TOKEN === undefined
  ) {
    throw new Error('mini app configuration unavailable');
  }
  return {
    custodyMode: env.NEXT_PUBLIC_WAGER_CUSTODY_MODE,
    engineToken: env.WEB_CONCIERGE_TOKEN,
    engineUrl: env.CONCIERGE_WALLET_API_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  };
}

function idempotencyBucket(now: Date): number {
  return Math.floor(now.getTime() / 1_000 / IDEMPOTENCY_BUCKET_SECONDS);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function refusal(status: number, error: string): MiniAppApiResult {
  return { status, body: { error } };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
