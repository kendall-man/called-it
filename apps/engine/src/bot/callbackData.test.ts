import { describe, expect, it } from 'vitest';
import {
  CALLBACK_DATA_MAX_BYTES,
  decodeCallback,
  encodeCallback,
  type CallbackAction,
} from './callbackData.js';

const CLAIM_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const MARKET_ID = '0f14d0ab-9605-4a62-a9e4-5ed26688389b';

const ROUND_TRIPS: CallbackAction[] = [
  { t: 'prove', claimId: CLAIM_ID },
  { t: 'option', claimId: CLAIM_ID, key: '0' },
  { t: 'option', claimId: CLAIM_ID, key: 'up' },
  { t: 'confirm', claimId: CLAIM_ID },
  { t: 'decline', claimId: CLAIM_ID },
  { t: 'stake', marketId: MARKET_ID, side: 'back', presetIndex: 2 },
  { t: 'stake', marketId: MARKET_ID, side: 'doubt', presetIndex: 0 },
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
      `op:${CLAIM_ID}:`,
      'sg:z',
      'sw:2',
      'unknown:payload',
      'pv:' + CLAIM_ID + ':extra',
    ];
    for (const data of garbage) {
      expect(decodeCallback(data)).toBeNull();
    }
  });
});
