import { describe, expect, it } from 'vitest';
import { canonicalReceiptId, decodeReceiptId, encodeReceiptId } from './receipt-id';

const UUID = '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f';
const COMPACT_ID = 'TcuIci8eS8WbQxorPE1ebw';

describe('receipt ids', () => {
  it('matches the engine fixed vector and reverses to the canonical UUID', () => {
    expect(encodeReceiptId(UUID)).toBe(COMPACT_ID);
    expect(decodeReceiptId(COMPACT_ID)).toBe(UUID);
  });

  it('keeps old UUID routes permanent while accepting compact routes', () => {
    expect(canonicalReceiptId(UUID.toUpperCase())).toBe(UUID);
    expect(canonicalReceiptId(COMPACT_ID)).toBe(UUID);
    expect(canonicalReceiptId('not-a-receipt')).toBeNull();
  });
});
