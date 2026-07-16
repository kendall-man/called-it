import { describe, expect, it } from 'vitest';
import { groupPointsDbFromClient } from './group-points.js';
import { captureRejection, MARKET_ID, rpcDb } from './group-points-test-support.js';

describe('group points RPC boundary', () => {
  it('rejects malformed Supabase envelopes and redacts database error messages', async () => {
    // Given malformed transport envelopes from an otherwise callable client
    const rawSentinel = 'RAW_POSTGREST_MESSAGE_MUST_NOT_LEAK';
    for (const response of [null, { data: null }, { error: null }]) {
      const db = groupPointsDbFromClient({
        from() {
          throw new TypeError('table query was not expected');
        },
        rpc() {
          return Promise.resolve(response);
        },
      });

      // When an envelope crosses the RPC boundary, then it fails as a contract error
      const error = await captureRejection(db.applyGroupPoints(MARKET_ID));
      expect(error.message).toContain('database contract violation');
      expect(error.message).not.toContain(rawSentinel);
    }

    // Given a real database failure containing an unsafe raw message
    const databaseError = await captureRejection(
      rpcDb({
        data: null,
        error: { message: rawSentinel, code: 'XX999' },
      }).applyGroupPoints(MARKET_ID),
    );

    // Then callers receive the safe operation surface without the raw message
    expect(databaseError.message).toContain('database operation failed');
    expect(databaseError.message).not.toContain(rawSentinel);
  });

  it('rejects error scoring variants that contain success-only fields', async () => {
    // Given an error discriminant mixed with the complete success payload shape
    const rawSentinel = 'MIXED_ERROR_VARIANT_MUST_NOT_LEAK';
    const db = rpcDb({
      data: {
        ok: false,
        code: 'market_not_found',
        eligible: false,
        duplicate: false,
        reason: rawSentinel,
        group_id: -100_123,
        scored_count: 0,
        winner_count: 0,
      },
      error: null,
    });

    // When the RPC result is parsed
    const error = await captureRejection(db.applyGroupPoints(MARKET_ID));

    // Then union exclusivity fails closed without leaking payload data
    expect(error.message).toContain('database contract violation at <keys>');
    expect(error.message).not.toContain(rawSentinel);
  });

  it('rejects success scoring variants that contain an error code', async () => {
    // Given a success discriminant mixed with the error-only code field
    const rawSentinel = 'MIXED_SUCCESS_VARIANT_MUST_NOT_LEAK';
    const db = rpcDb({
      data: {
        ok: true,
        eligible: true,
        duplicate: false,
        reason: null,
        group_id: -100_123,
        scored_count: 1,
        winner_count: 1,
        code: rawSentinel,
      },
      error: null,
    });

    // When the RPC result is parsed
    const error = await captureRejection(db.applyGroupPoints(MARKET_ID));

    // Then union exclusivity fails closed without leaking payload data
    expect(error.message).toContain('database contract violation at <keys>');
    expect(error.message).not.toContain(rawSentinel);
  });

  it('rejects unknown keys on otherwise valid scoring variants', async () => {
    // Given exact error and success variants with one unrecognized field each
    const rawSentinel = 'UNKNOWN_RPC_KEY_MUST_NOT_LEAK';
    const payloads: readonly unknown[] = [
      { ok: false, code: 'settlement_missing', unexpected: rawSentinel },
      {
        ok: true,
        eligible: false,
        duplicate: false,
        reason: 'replay',
        group_id: -100_123,
        scored_count: 0,
        winner_count: 0,
        unexpected: rawSentinel,
      },
    ];

    // When either payload is parsed
    for (const payload of payloads) {
      const error = await captureRejection(
        rpcDb({ data: payload, error: null }).applyGroupPoints(MARKET_ID),
      );

      // Then exact-key enforcement rejects it redacted
      expect(error.message).toContain('database contract violation at <keys>');
      expect(error.message).not.toContain(rawSentinel);
    }
  });

  it('rejects malformed injected clients at the facade boundary', () => {
    // Given values that do not expose both required database methods
    const malformedClients: readonly unknown[] = [null, {}, { from() {} }, { rpc() {} }];

    // When each value is used to create the facade, then it fails before any operation
    for (const client of malformedClients) {
      expect(() => groupPointsDbFromClient(client)).toThrow('malformed Supabase client');
    }
  });
});
