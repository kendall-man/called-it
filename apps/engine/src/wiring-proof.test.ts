import { describe, expect, it } from 'vitest';
import { BASE_ENV } from './env.test-fixtures.js';
import { loadEnv } from './env.js';
import type { Logger } from './log.js';
import { createProductionProofSubmitter } from './wiring-proof.js';

function createLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => createLogger(),
  };
}

describe('createProductionProofSubmitter', () => {
  it('rethrows a non-Error value thrown while mapping malformed proof input', async () => {
    const env = loadEnv({ ...BASE_ENV, SOLANA_KEYPAIR_B58: 'proof-secret' });
    const submitter = createProductionProofSubmitter(env, createLogger(), {
      createConnection: () => ({}),
      loadWallet: () => ({}),
      submit: async () => ({ ok: true, txSig: 'unused' }),
    });
    expect(submitter).not.toBeNull();
    if (submitter === null) throw new Error('proof submitter unexpectedly disabled');
    const thrown = Object.freeze({ sentinel: 'non-error' });
    const proof = Object.defineProperty({}, 'summary', {
      get: () => {
        throw thrown;
      },
    });

    await expect(submitter.submit({
      fixtureId: 1,
      seq: 2,
      statKey: 3,
      comparator: 'eq',
      threshold: 4,
      proof,
    })).rejects.toBe(thrown);
  });
});
