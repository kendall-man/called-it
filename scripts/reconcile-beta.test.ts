import assert from 'node:assert/strict';
import test from 'node:test';
import { runReadOnlyBetaClassifier } from './reconcile-beta.js';

test('beta reconciliation classifier returns aggregate reason codes without mutation', async () => {
  let calls = 0;
  const summary = await runReadOnlyBetaClassifier({
    async classifyLegacyWalletReconciliation() {
      calls += 1;
      return {
        unresolved_count: 3,
        unverified_link_count: 1,
        orphan_deposit_count: 2,
        reasons: [
          { kind: 'orphan_deposit', reason: 'legacy_orphan', count: 2 },
          { kind: 'unverified_link', reason: 'pre_migration_unverified_link', count: 1 },
        ],
      };
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(summary, {
    unresolved_count: 3,
    unverified_link_count: 1,
    orphan_deposit_count: 2,
    reasons: [
      { kind: 'orphan_deposit', reason: 'legacy_orphan', count: 2 },
      { kind: 'unverified_link', reason: 'pre_migration_unverified_link', count: 1 },
    ],
  });
});
