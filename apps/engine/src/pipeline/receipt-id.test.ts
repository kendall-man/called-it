import { describe, expect, it } from 'vitest';
import { decodeReceiptId, encodeReceiptId } from './receipt-id.js';

const UUID = '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f';
const COMPACT_ID = 'TcuIci8eS8WbQxorPE1ebw';

describe('receipt ids', () => {
  it('matches the shared fixed vector and reverses without dependencies', () => {
    expect(encodeReceiptId(UUID)).toBe(COMPACT_ID);
    expect(decodeReceiptId(COMPACT_ID)).toBe(UUID);
  });

  it('rejects malformed UUIDs and non-canonical compact encodings', () => {
    expect(encodeReceiptId('not-a-uuid')).toBeNull();
    expect(decodeReceiptId(`${COMPACT_ID.slice(0, -1)}x`)).toBeNull();
    expect(decodeReceiptId(COMPACT_ID.slice(1))).toBeNull();
  });
});
