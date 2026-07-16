import assert from 'node:assert/strict';
import { connection } from './runtime.js';
import { recoveryDecision } from './recovery.js';
import type { BootstrapContext, PlacedPosition } from './types.js';

export async function proveSignatureRecovery(context: BootstrapContext, placement: PlacedPosition): Promise<void> {
  const rpc = connection(context.rpcUrl);
  const vaultBefore = await rpc.getBalance(placement.market.vault, 'finalized');
  const statuses = await rpc.getSignatureStatuses([placement.signature, '1'.repeat(64)], {
    searchTransactionHistory: true,
  });
  assert(statuses.value[0] !== null && statuses.value[0]?.err === null, 'known signature must be recoverable');
  assert.equal(statuses.value[1], null, 'unknown signature must remain distinguishable');
  const height = BigInt(await rpc.getBlockHeight('finalized'));
  assert.deepEqual(recoveryDecision({
    status: 'finalized', blockHeight: height, lastValidBlockHeight: placement.lastValidBlockHeight,
  }), { kind: 'finalized' });
  assert.deepEqual(recoveryDecision({
    status: 'unknown', blockHeight: height, lastValidBlockHeight: placement.lastValidBlockHeight,
  }), { kind: 'retry_exact_bytes' });
  try {
    const retried = await rpc.sendRawTransaction(placement.signedBytes, { preflightCommitment: 'confirmed' });
    assert.equal(retried, placement.signature, 'retry must submit the exact signed transaction bytes');
  } catch (error) {
    if (!(error instanceof Error) || !/already been processed/i.test(error.message)) throw error;
    const recovered = (await rpc.getSignatureStatuses([placement.signature], {
      searchTransactionHistory: true,
    })).value[0];
    assert.equal(recovered?.confirmationStatus, 'finalized');
    assert.equal(recovered?.err, null);
  }
  assert.equal(
    await rpc.getBalance(placement.market.vault, 'finalized'),
    vaultBefore,
    'exact-byte retry must not transfer principal twice',
  );
}
