import {
  createTelegramFetch,
  telegramJsonResponse,
  type TelegramFetchInput,
} from '../points/telegram-points-flow-fetch.test-support.js';

type FetchBody = NonNullable<Parameters<typeof fetch>[1]>['body'] | undefined;

export const SETTLEMENT_TEST_ENV = {
  DEPLOYMENT_ENV: 'development', TELEGRAM_BOT_TOKEN: '1234567890:test-token',
  TELEGRAM_BOT_USERNAME: 'CalledItBot', BETA_ALLOWED_GROUP_IDS: '', GLM_API_KEY: 'test-glm-key',
  SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  TXLINE_API_BASE: 'https://txline.invalid', TXLINE_GUEST_JWT: 'test-guest-jwt',
  TXLINE_API_TOKEN: 'test-api-token', TXORACLE_PROGRAM_ID: '11111111111111111111111111111111',
  TXL_MINT: '22222222222222222222222222222222', WEB_BASE_URL: 'https://web.invalid',
  WALLET_LINK_DOMAIN: 'web.invalid',
  ANALYTICS_HMAC_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ENGINE_CONCIERGE_TOKEN: 'concierge-token-0000000000000000000000',
  ENGINE_TELEGRAM_TOKEN: 'telegram-token-00000000000000000000000',
  ENGINE_OPS_TOKEN: 'operations-token-0000000000000000000000',
  WAGER_MODE_ENABLED: 'false', STARTER_GRANTS_ENABLED: 'false',
  WALLET_MINIAPP_ENABLED: 'false', STAKE_ACCEPTANCE_ENABLED: 'false',
  TREASURY_COVERAGE_ENFORCED: 'false', QUEUE_LEASE_MS: '10000', QUEUE_MAX_ATTEMPTS: '5',
  QUEUE_RETRY_BASE_MS: '100', QUEUE_RETRY_MAX_MS: '1000', READINESS_CHECK_TIMEOUT_MS: '1000',
  READINESS_FEED_MAX_AGE_MS: '60000', READINESS_WORKER_MAX_AGE_MS: '60000',
  READINESS_INGRESS_MAX_AGE_MS: '60000', READINESS_PROOF_MAX_BACKLOG: '100',
  READINESS_PROOF_MAX_OLDEST_AGE_MS: '60000', READINESS_SETTLEMENT_MAX_BACKLOG: '100',
  READINESS_SETTLEMENT_MAX_OLDEST_AGE_MS: '60000', SHUTDOWN_DRAIN_TIMEOUT_MS: '5000',
} satisfies NodeJS.ProcessEnv;

export class TelegramTransport {
  readonly texts: string[] = [];
  attempts = 0;
  private nextGate: Promise<void> | null = null;
  private failuresRemaining = 0;

  constructor(
    private readonly timeline: string[],
    private readonly groupId: number,
    private readonly nowMs: number,
  ) {}

  pauseNext(): () => void {
    let release = (): void => undefined;
    this.nextGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => release();
  }

  failNext(): void {
    this.failuresRemaining += 1;
  }

  readonly fetch = createTelegramFetch(async (input, init) => {
    // Presence traffic (reactions, chat actions) is budget-free and
    // best-effort; keep it out of the delivery timeline, retry gates, and
    // message-id sequence these settlement tests assert on.
    if (isPresenceMethod(input)) return telegramJsonResponse({ ok: true, result: true });
    this.attempts += 1;
    const gate = this.nextGate;
    this.nextGate = null;
    if (gate !== null) await gate;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      this.timeline.push('telegram_send_failed');
      return telegramJsonResponse({
        ok: false, error_code: 500, description: 'test send unavailable',
      });
    }
    this.timeline.push('telegram_send');
    const body: FetchBody = typeof init?.body === 'string' ? init.body : undefined;
    const text = requestText(body);
    if (text !== null) this.texts.push(text);
    return telegramJsonResponse({
      ok: true,
      result: {
        message_id: this.attempts, date: Math.floor(this.nowMs / 1000),
        chat: { id: this.groupId, type: 'supergroup', title: 'Test group' }, text: text ?? '',
      },
    });
  });
}

function isPresenceMethod(input: TelegramFetchInput): boolean {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : 'url' in input
        ? input.url
        : input.href;
  const method = url.split('/').at(-1) ?? '';
  return method === 'setMessageReaction' || method === 'sendChatAction';
}

function requestText(body: FetchBody): string | null {
  if (typeof body !== 'string') return null;
  const payload: unknown = JSON.parse(body);
  if (typeof payload !== 'object' || payload === null || !('text' in payload)) return null;
  return typeof payload.text === 'string' ? payload.text : null;
}
