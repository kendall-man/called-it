import type { RecoveryOperation } from './recovery.js';
import { DEVNET_WRITE_CONSENT } from './recovery.js';
import { fail } from './errors.js';

export interface RecoveryCliOptions {
  readonly operation: RecoveryOperation;
  readonly rpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly programId: string;
  readonly canonicalUsdcMint: string;
  readonly marketUuid: string;
  readonly owner: string;
  readonly submit: boolean;
  readonly devnetWriteConsent: string | undefined;
  readonly keypairPath: string | undefined;
}

const OPERATIONS = new Set<RecoveryOperation>(['inspect', 'claim', 'refund', 'timeout-refund']);
type ValueField =
  | 'rpcUrl'
  | 'expectedGenesisHash'
  | 'programId'
  | 'canonicalUsdcMint'
  | 'marketUuid'
  | 'owner'
  | 'keypairPath'
  | 'devnetWriteConsent';

const VALUE_FLAGS: ReadonlyMap<string, ValueField> = new Map([
  ['--rpc', 'rpcUrl'],
  ['--genesis', 'expectedGenesisHash'],
  ['--program', 'programId'],
  ['--usdc-mint', 'canonicalUsdcMint'],
  ['--market', 'marketUuid'],
  ['--owner', 'owner'],
  ['--keypair', 'keypairPath'],
  ['--devnet-write-consent', 'devnetWriteConsent'],
] as const);

export function parseRecoveryCli(argv: readonly string[]): RecoveryCliOptions {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const operation = args[0];
  if (operation === undefined || !OPERATIONS.has(operation as RecoveryOperation)) {
    fail('input_invalid', 'first argument must be inspect, claim, refund, or timeout-refund');
  }
  const values: Partial<Record<ValueField, string>> = {};
  let submit = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--submit') {
      if (submit) fail('input_invalid', 'duplicate --submit flag');
      submit = true;
      continue;
    }
    const field = VALUE_FLAGS.get(argument ?? '');
    if (field === undefined) fail('input_invalid', 'unknown or forbidden command-line argument');
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) fail('input_invalid', `${argument} requires a value`);
    if (values[field] !== undefined) fail('input_invalid', `duplicate ${argument} flag`);
    values[field] = value;
    index += 1;
  }
  for (const field of ['rpcUrl', 'expectedGenesisHash', 'programId', 'canonicalUsdcMint', 'marketUuid', 'owner'] as const) {
    if (values[field] === undefined || values[field]?.trim().length === 0) fail('input_invalid', `missing required ${field}`);
  }
  if (!submit && (values.keypairPath !== undefined || values.devnetWriteConsent !== undefined)) {
    fail('input_invalid', '--keypair and --devnet-write-consent are accepted only with --submit');
  }
  if (submit && operation === 'inspect') fail('input_invalid', 'inspect cannot be submitted');
  if (submit && values.keypairPath === undefined) fail('input_invalid', '--submit requires --keypair');
  if (submit && values.devnetWriteConsent === undefined) {
    fail('input_invalid', `--submit requires --devnet-write-consent ${DEVNET_WRITE_CONSENT}`);
  }
  return {
    operation: operation as RecoveryOperation,
    rpcUrl: values.rpcUrl!,
    expectedGenesisHash: values.expectedGenesisHash!,
    programId: values.programId!,
    canonicalUsdcMint: values.canonicalUsdcMint!,
    marketUuid: values.marketUuid!,
    owner: values.owner!,
    submit,
    devnetWriteConsent: values.devnetWriteConsent,
    keypairPath: values.keypairPath,
  };
}

export const RECOVERY_USAGE = `Usage:
  calledit-escrow-recovery <inspect|claim|refund|timeout-refund> \\
    --rpc <https-url> --genesis <hash> --program <pubkey> \\
    --usdc-mint <pubkey> --market <uuid> --owner <pubkey>

Dry-run is the default. To submit on canonical Solana devnet only, add:
  --submit --keypair <0600-json-file> \\
  --devnet-write-consent ${DEVNET_WRITE_CONSENT}

Output is one JSON recovery-evidence document. Raw private keys are never accepted.`;
