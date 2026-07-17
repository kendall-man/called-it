/**
 * Shared start-param contract for the direct-link Mini App entry (/app).
 *
 * The group card's URL buttons carry `startapp=p-<marketId32>-<b|d>` where
 * `marketId32` is the market uuid without dashes, plus an OPTIONAL amount code
 * suffix `-<1|2|5|10>` (base units of 0.01 SOL) added by the two-step value
 * ladder. The param is public (no secret): the engine mints the placement
 * session only after the web server verifies Telegram initData, so the
 * client-side parse is used for routing alone and the server re-parses the
 * param from the signed initData.
 *
 * Backward compatibility: every already-posted card omits the amount suffix, so
 * an absent amount defaults to code 1 (0.01 SOL) — the pre-ladder behaviour.
 */

export const MINIAPP_POSITION_START_PARAM_PATTERN = /^p-([0-9a-f]{32})-([bd])(?:-(1|2|5|10))?$/;

export type MiniAppPositionSide = 'back' | 'against';

/** Base units of 0.01 SOL; the shared wire form for the ladder amount. */
export type MiniAppAmountCode = 1 | 2 | 5 | 10;

/** Absent amount → the base stake (0.01 SOL), matching every legacy card. */
export const DEFAULT_MINIAPP_AMOUNT_CODE: MiniAppAmountCode = 1;

export type MiniAppPositionIntent = {
  readonly marketId: string;
  readonly side: MiniAppPositionSide;
  readonly amountCode: MiniAppAmountCode;
};

function toAmountCode(raw: string | undefined): MiniAppAmountCode {
  switch (raw) {
    case '2':
      return 2;
    case '5':
      return 5;
    case '10':
      return 10;
    default:
      return DEFAULT_MINIAPP_AMOUNT_CODE;
  }
}

export function parseMiniAppPositionStartParam(value: string): MiniAppPositionIntent | null {
  const match = MINIAPP_POSITION_START_PARAM_PATTERN.exec(value);
  const hex = match?.[1];
  const sideCode = match?.[2];
  if (hex === undefined || sideCode === undefined) return null;
  const marketId = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
  return {
    marketId,
    side: sideCode === 'b' ? 'back' : 'against',
    amountCode: toAmountCode(match?.[3]),
  };
}

/**
 * Reads `start_param` from a raw initData query string. Callers must verify
 * the initData HMAC first; this helper only extracts an already-trusted field.
 */
export function startParamFromInitData(initData: string): string | null {
  const value = new URLSearchParams(initData).get('start_param');
  return value !== null && value.length > 0 ? value : null;
}

const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Reads the optional username from a verified initData query string. The
 * username is advisory display data for the engine, never identity.
 */
export function telegramUsernameFromInitData(initData: string): string | null {
  const userValue = new URLSearchParams(initData).get('user');
  if (userValue === null) return null;
  let user: unknown;
  try {
    user = JSON.parse(userValue);
  } catch {
    return null;
  }
  if (typeof user !== 'object' || user === null || Array.isArray(user)) return null;
  const username = (user as Readonly<Record<string, unknown>>).username;
  return typeof username === 'string' && TELEGRAM_USERNAME_PATTERN.test(username)
    ? username
    : null;
}
