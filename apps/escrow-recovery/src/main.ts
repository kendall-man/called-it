#!/usr/bin/env node
import { PublicKey } from '@solana/web3.js';
import { parseRecoveryCli, RECOVERY_USAGE } from './cli.js';
import { loadOwnerKeypair } from './credentials.js';
import { RecoveryError } from './errors.js';
import {
  assertDevnetWriteConsent,
  prepareRecovery,
  recoveryEvidence,
  submitRecovery,
} from './recovery.js';
import { createRecoveryRpc } from './rpc.js';

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 0 || argv.includes('--help')) {
    process.stdout.write(`${RECOVERY_USAGE}\n`);
    return;
  }
  const options = parseRecoveryCli(argv);
  const rpc = createRecoveryRpc(options.rpcUrl);
  const preparation = await prepareRecovery({
    operation: options.operation,
    expectedGenesisHash: options.expectedGenesisHash,
    programId: options.programId,
    canonicalUsdcMint: options.canonicalUsdcMint,
    marketUuid: options.marketUuid,
    owner: options.owner,
    rpc,
  });
  if (!options.submit) {
    process.stdout.write(`${JSON.stringify(recoveryEvidence(preparation))}\n`);
    return;
  }
  assertDevnetWriteConsent(preparation, options.devnetWriteConsent);
  const keypair = await loadOwnerKeypair(options.keypairPath!, new PublicKey(options.owner));
  const submission = await submitRecovery({
    preparation,
    ownerKeypair: keypair,
    devnetWriteConsent: options.devnetWriteConsent!,
    rpc,
  });
  process.stdout.write(`${JSON.stringify(recoveryEvidence(preparation, submission))}\n`);
}

main(process.argv.slice(2)).catch((cause: unknown) => {
  const error = cause instanceof RecoveryError
    ? { code: cause.code, message: cause.message }
    : { code: 'internal_error', message: 'unexpected recovery client failure' };
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, kind: 'calledit-escrow-recovery-error', error })}\n`);
  process.exitCode = 1;
});
