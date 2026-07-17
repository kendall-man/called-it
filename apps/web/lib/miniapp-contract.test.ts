import { describe, expect, it } from 'vitest';
import {
  MINIAPP_POSITION_START_PARAM_PATTERN,
  parseMiniAppPositionStartParam,
  startParamFromInitData,
  telegramUsernameFromInitData,
} from './miniapp-contract';

const MARKET_HEX = '8ec17c8a2a304f089b757cbe565d568f';
const MARKET_ID = '8ec17c8a-2a30-4f08-9b75-7cbe565d568f';

describe('Mini App start-param contract', () => {
  it('parses a back-side param and defaults an absent amount to the base stake', () => {
    // Every already-posted card omits the amount suffix → code 1 (0.01 SOL).
    expect(parseMiniAppPositionStartParam(`p-${MARKET_HEX}-b`)).toEqual({
      marketId: MARKET_ID,
      side: 'back',
      amountCode: 1,
    });
  });

  it('parses an against-side param', () => {
    expect(parseMiniAppPositionStartParam(`p-${MARKET_HEX}-d`)).toEqual({
      marketId: MARKET_ID,
      side: 'against',
      amountCode: 1,
    });
  });

  it('parses the ladder amount code suffix (1/2/5/10)', () => {
    for (const code of [1, 2, 5, 10] as const) {
      expect(parseMiniAppPositionStartParam(`p-${MARKET_HEX}-b-${code}`)).toEqual({
        marketId: MARKET_ID,
        side: 'back',
        amountCode: code,
      });
    }
  });

  it('rejects amount suffixes off the 1-2-5-10 series', () => {
    for (const bad of ['3', '4', '0', '01', '100', 'x']) {
      expect(parseMiniAppPositionStartParam(`p-${MARKET_HEX}-b-${bad}`), bad).toBeNull();
    }
  });

  it('rejects params outside the exact contract shape', () => {
    const invalid = [
      '',
      `p-${MARKET_HEX}-x`,
      `p-${MARKET_HEX.toUpperCase()}-b`,
      `p-${MARKET_HEX.slice(0, 31)}-b`,
      `p-${MARKET_HEX}0-b`,
      `q-${MARKET_HEX}-b`,
      `p-${MARKET_ID}-b`,
      `p-${MARKET_HEX}-b-extra`,
      ` p-${MARKET_HEX}-b`,
    ];
    for (const value of invalid) {
      expect(parseMiniAppPositionStartParam(value), value).toBeNull();
      expect(MINIAPP_POSITION_START_PARAM_PATTERN.test(value), value).toBe(false);
    }
  });

  it('stays within the 64-char [A-Za-z0-9_-] startapp budget (longest suffix)', () => {
    const param = `p-${MARKET_HEX}-b-10`;
    expect(param.length).toBeLessThanOrEqual(64);
    expect(/^[A-Za-z0-9_-]+$/.test(param)).toBe(true);
  });

  it('extracts start_param from a raw initData query string', () => {
    const initData = new URLSearchParams({
      auth_date: '1',
      start_param: `p-${MARKET_HEX}-b`,
      hash: 'aa'.repeat(32),
    }).toString();
    expect(startParamFromInitData(initData)).toBe(`p-${MARKET_HEX}-b`);
    expect(startParamFromInitData('auth_date=1&hash=aa')).toBeNull();
    expect(startParamFromInitData('start_param=&auth_date=1')).toBeNull();
  });

  it('extracts only a well-formed username from verified initData', () => {
    const initDataFor = (user: unknown) => new URLSearchParams({
      auth_date: '1',
      user: JSON.stringify(user),
      hash: 'aa'.repeat(32),
    }).toString();
    expect(telegramUsernameFromInitData(initDataFor({ id: 42, username: 'callie_fan' })))
      .toBe('callie_fan');
    expect(telegramUsernameFromInitData(initDataFor({ id: 42 }))).toBeNull();
    expect(telegramUsernameFromInitData(initDataFor({ id: 42, username: 'bad name!' }))).toBeNull();
    expect(telegramUsernameFromInitData(initDataFor({ id: 42, username: 7 }))).toBeNull();
    expect(telegramUsernameFromInitData('auth_date=1&user=not-json')).toBeNull();
    expect(telegramUsernameFromInitData('auth_date=1')).toBeNull();
  });
});
