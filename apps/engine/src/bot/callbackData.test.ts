import { describe, expect, it } from 'vitest';
import {
  CALLBACK_DATA_MAX_BYTES,
  decodeCallback,
  encodeCallback,
  type CallbackAction,
} from './callbackData.js';

const CLAIM_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const MARKET_ID = '0f14d0ab-9605-4a62-a9e4-5ed26688389b';
const INTENT_ID = '91b6e582-a8ea-4b5d-aa10-9fd037203cf2';

const ROUND_TRIPS: CallbackAction[] = [
  { t: 'prove', claimId: CLAIM_ID },
  { t: 'option', claimId: CLAIM_ID, key: '0' },
  { t: 'option', claimId: CLAIM_ID, key: 'up' },
  { t: 'confirm', claimId: CLAIM_ID },
  { t: 'decline', claimId: CLAIM_ID },
  { t: 'stake', marketId: MARKET_ID, side: 'back', presetIndex: 0 },
  { t: 'stake', marketId: MARKET_ID, side: 'doubt', presetIndex: 0 },
  { t: 'stake_value', marketId: MARKET_ID, side: 'back', amountCode: 1 },
  { t: 'stake_value', marketId: MARKET_ID, side: 'doubt', amountCode: 2 },
  { t: 'stake_value', marketId: MARKET_ID, side: 'back', amountCode: 5 },
  { t: 'stake_value', marketId: MARKET_ID, side: 'doubt', amountCode: 10 },
  { t: 'stake_back', marketId: MARKET_ID },
  { t: 'stake_confirm', intentId: INTENT_ID },
  { t: 'stake_cancel', intentId: INTENT_ID },
  { t: 'void_replay_blocker', marketId: MARKET_ID },
  { t: 'chattiness', mode: 'react_only' },
  { t: 'web', enabled: false },
];

describe('callback data codec', () => {
  it('round-trips every action shape', () => {
    for (const action of ROUND_TRIPS) {
      expect(decodeCallback(encodeCallback(action))).toEqual(action);
    }
  });

  it('stays within the Telegram 64-byte callback_data limit', () => {
    for (const action of ROUND_TRIPS) {
      expect(Buffer.byteLength(encodeCallback(action), 'utf8')).toBeLessThanOrEqual(
        CALLBACK_DATA_MAX_BYTES,
      );
    }
  });

  it('returns null (stale tap) for malformed or foreign payloads', () => {
    const garbage = [
      '',
      'pv:',
      'pv:not-a-uuid',
      `st:${MARKET_ID}:x:1`,
      `st:${MARKET_ID}:b:99`,
      `sv:${MARKET_ID}:b:0`, // 0 is not a rung
      `sv:${MARKET_ID}:b:3`, // 3 is not on the 1-2-5 series
      `sv:${MARKET_ID}:x:1`, // bad side
      `sv:${MARKET_ID}:b`, // missing code
      `sv:not-a-uuid:b:1`,
      `sb:not-a-uuid`,
      `sb:${MARKET_ID}:extra`,
      `op:${CLAIM_ID}:`,
      'vr:not-a-uuid',
      'sg:z',
      'sw:2',
      'unknown:payload',
      'pv:' + CLAIM_ID + ':extra',
    ];
    for (const data of garbage) {
      expect(decodeCallback(data)).toBeNull();
    }
  });

  it('keeps only the beta consent and fixed-stake callbacks live', () => {
    expect(decodeCallback('wg:1')).toBeNull();
    expect(decodeCallback('wg:0')).toBeNull();
    expect(decodeCallback(`st:${MARKET_ID}:b:1`)).toBeNull();
    expect(decodeCallback(`am:${MARKET_ID}`)).toBeNull();
    expect(decodeCallback(`ap:${MARKET_ID}:abCD_123:b:1`)).toBeNull();
  });
});
