import { describe, expect, it } from 'vitest';
import {
  proofSubmissionOutboxDbFromClient,
  type ProofSubmissionOutboxDbClient,
} from './proof-submission-outbox.js';

const MARKET_ID = '11111111-1111-1111-1111-111111111111';
const SIGNATURE = 'A'.repeat(64);
const RAW_TX = 'QUJDREVGR0g=';
const NOW = '2026-07-12T00:00:00.000Z';
const ROW = {
  market_id: MARKET_ID,
  attempt: 1,
  state: 'prepared',
  signature: SIGNATURE,
  raw_tx_b64: RAW_TX,
  last_valid_block_height: 123,
  proof_payload: { summary: { updateStats: { minTimestamp: 1 } } },
  broadcast_count: 0,
  prepared_at: NOW,
  last_broadcast_at: null,
  landed_at: null,
  expired_at: null,
  updated_at: NOW,
};

describe('proof submission outbox facade', () => {
  it('persists raw signed bytes before any engine broadcast through the prepare RPC', async () => {
    // Given an RPC client that records the private facade call
    const calls: Array<{ readonly fn: string; readonly args: Record<string, unknown> }> = [];
    const db = proofSubmissionOutboxDbFromClient(client(async (fn, args) => {
      calls.push({ fn, args });
      return { ok: true, duplicate: false, outbox: ROW };
    }));

    // When the engine prepares a newly signed transaction
    const result = await db.prepare({
      marketId: MARKET_ID,
      signature: SIGNATURE,
      rawTxB64: RAW_TX,
      lastValidBlockHeight: 123,
      proofPayload: ROW.proof_payload,
      nowIso: NOW,
    });

    // Then the raw bytes, signature, expiry, and proof are atomically passed to the outbox RPC
    expect(result).toEqual({
      ok: true,
      duplicate: false,
      outbox: {
        marketId: MARKET_ID,
        attempt: 1,
        state: 'prepared',
        signature: SIGNATURE,
        rawTxB64: RAW_TX,
        lastValidBlockHeight: 123,
        proofPayload: ROW.proof_payload,
        broadcastCount: 0,
        preparedAt: NOW,
        lastBroadcastAt: null,
        landedAt: null,
        expiredAt: null,
        updatedAt: NOW,
      },
    });
    expect(calls).toEqual([
      {
        fn: 'proof_submission_prepare',
        args: {
          p_market_id: MARKET_ID,
          p_signature: SIGNATURE,
          p_raw_tx_b64: RAW_TX,
          p_last_valid_block_height: 123,
          p_proof_payload: ROW.proof_payload,
          p_now: NOW,
        },
      },
    ]);
  });

  it('keeps a missing outbox distinct from an RPC failure', async () => {
    // Given a valid no-row result from the durable outbox
    const db = proofSubmissionOutboxDbFromClient(client(async () => ({ ok: true, outbox: null })));

    // When recovery looks for the market
    const result = await db.get(MARKET_ID);

    // Then it may safely build a first transaction
    expect(result).toEqual({ ok: true, outbox: null });
  });

  it('rejects malformed private rows without placing signed bytes in the error message', async () => {
    // Given a malformed RPC row containing sensitive raw transaction material
    const db = proofSubmissionOutboxDbFromClient(client(async () => ({
      ok: true,
      duplicate: false,
      outbox: { ...ROW, raw_tx_b64: 'x', state: 'prepared' },
    })));

    // When the facade parses it
    const operation = db.markBroadcast({ marketId: MARKET_ID, attempt: 1, signature: SIGNATURE, nowIso: NOW });

    // Then callers get a bounded structural error, never the raw payload
    await expect(operation).rejects.toThrow('malformed proof submission payload');
    await expect(operation).rejects.not.toThrow('raw_tx_b64: x');
  });
});

function client(
  handler: (fn: string, args: Record<string, unknown>) => Promise<unknown>,
): ProofSubmissionOutboxDbClient {
  return {
    async rpc(fn, args) {
      return { data: await handler(fn, args), error: null };
    },
  };
}
