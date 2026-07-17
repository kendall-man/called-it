/**
 * Read-only beta reconciliation classifier. It intentionally asks the
 * database only for aggregate reason codes: wallet addresses, deposit rows,
 * ledger amounts, and mutation methods never cross this boundary.
 */

import { pathToFileURL } from 'node:url';
import { createWagerDb } from '../packages/db/src/wager-db.js';
import type { WagerLegacyReconciliationSummary } from '../packages/db/src/wager-types.js';

type LegacyReconciliationReader = {
  classifyLegacyWalletReconciliation(): Promise<WagerLegacyReconciliationSummary>;
};

export async function runReadOnlyBetaClassifier(
  reader: LegacyReconciliationReader,
): Promise<WagerLegacyReconciliationSummary> {
  return reader.classifyLegacyWalletReconciliation();
}

async function main(): Promise<void> {
  const url = requiredEnv('SUPABASE_URL');
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const summary = await runReadOnlyBetaClassifier(createWagerDb(url, serviceRoleKey));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function requiredEnv(name: 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required for the read-only beta classifier`);
  }
  return value;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  // no-excuse-ok: catch
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
