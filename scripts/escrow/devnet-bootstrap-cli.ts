import { pathToFileURL } from 'node:url';

import { bootstrapDevnet, DevnetBootstrapError, type DevnetBootstrapOptions } from './devnet-bootstrap.js';
import { redactedError, stableJson } from './util.js';

const USAGE = `Usage:
  pnpm escrow:devnet -- [--execute] [--rpc-env NAME | --rpc URL]
    --program-keypair PATH --program-so PATH
    --upgrade-authority-keypair PATH --transaction-payer-keypair PATH
    --config-authority-keypair PATH --pause-authority-keypair PATH
    --market-creation-authority-keypair PATH --feed-operator-authority-keypair PATH
    --relayer-fee-payer-keypair PATH --residual-recipient-keypair PATH
    --oracle-1-keypair PATH --oracle-2-keypair PATH --oracle-3-keypair PATH
    --oracle-activation-slot U64 --manifest-out PATH --env-out PATH

Dry-run is the default and never writes files or submits transactions. --execute
is required for deploy/upgrade, config/oracle initialization, and output writes.
The default RPC environment variable is SOLANA_DEVNET_RPC_URL.`;

const VALUE_OPTIONS = new Set([
  '--rpc',
  '--rpc-env',
  '--solana-bin',
  '--program-keypair',
  '--program-so',
  '--upgrade-authority-keypair',
  '--transaction-payer-keypair',
  '--config-authority-keypair',
  '--pause-authority-keypair',
  '--market-creation-authority-keypair',
  '--feed-operator-authority-keypair',
  '--relayer-fee-payer-keypair',
  '--residual-recipient-keypair',
  '--oracle-1-keypair',
  '--oracle-2-keypair',
  '--oracle-3-keypair',
  '--oracle-activation-slot',
  '--manifest-out',
  '--env-out',
]);

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) throw new DevnetBootstrapError(`missing required option ${name}`);
  return value;
}

function parseU64(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new DevnetBootstrapError(`${label} must be a positive u64 integer`);
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new DevnetBootstrapError(`${label} exceeds u64`);
  return parsed;
}

export function parseDevnetBootstrapArgs(argv: readonly string[], env: NodeJS.ProcessEnv): DevnetBootstrapOptions {
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (option === '--execute') {
      if (execute) throw new DevnetBootstrapError('duplicate option --execute');
      execute = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(option)) throw new DevnetBootstrapError(`unknown option ${option}`);
    if (values.has(option)) throw new DevnetBootstrapError(`duplicate option ${option}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new DevnetBootstrapError(`missing value for ${option}`);
    values.set(option, value);
    index += 1;
  }
  if (values.has('--rpc') && values.has('--rpc-env')) {
    throw new DevnetBootstrapError('use only one of --rpc or --rpc-env');
  }
  const rpcEnvironmentName = values.get('--rpc-env') ?? 'SOLANA_DEVNET_RPC_URL';
  const rpcUrl = values.get('--rpc') ?? env[rpcEnvironmentName];
  if (rpcUrl === undefined || rpcUrl.length === 0) {
    throw new DevnetBootstrapError(`RPC URL is missing from environment variable ${rpcEnvironmentName}`);
  }
  return {
    rpcUrl,
    solanaBinary: values.get('--solana-bin') ?? 'solana',
    programKeypairPath: required(values, '--program-keypair'),
    programSoPath: required(values, '--program-so'),
    roles: {
      upgradeAuthority: required(values, '--upgrade-authority-keypair'),
      transactionPayer: required(values, '--transaction-payer-keypair'),
      configAuthority: required(values, '--config-authority-keypair'),
      pauseAuthority: required(values, '--pause-authority-keypair'),
      marketCreationAuthority: required(values, '--market-creation-authority-keypair'),
      feedOperatorAuthority: required(values, '--feed-operator-authority-keypair'),
      relayerFeePayer: required(values, '--relayer-fee-payer-keypair'),
      residualRecipient: required(values, '--residual-recipient-keypair'),
      oracleSigners: [
        required(values, '--oracle-1-keypair'),
        required(values, '--oracle-2-keypair'),
        required(values, '--oracle-3-keypair'),
      ],
    },
    oracleActivationSlot: parseU64(required(values, '--oracle-activation-slot'), '--oracle-activation-slot'),
    manifestOutputPath: required(values, '--manifest-out'),
    envOutputPath: required(values, '--env-out'),
    execute,
  };
}

export async function run(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const options = parseDevnetBootstrapArgs(argv, env);
    const result = await bootstrapDevnet(options);
    process.stdout.write(stableJson(result));
    return 0;
  } catch (error) {
    process.stderr.write(`escrow-devnet-bootstrap: ${redactedError(error)}\n`);
    return error instanceof DevnetBootstrapError ? 3 : 8;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
