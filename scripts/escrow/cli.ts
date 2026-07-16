#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { createDevnetEvidence } from './evidence.js';
import { verifyIdlPolicy } from './idl-policy.js';
import { runLocalValidatorEvidence } from './local-validator-evidence.js';
import { verifyMainnetEvidence } from './mainnet-gate.js';
import { buildProvenance, parseBuildManifest, parseReleaseManifest, type ArtifactPaths } from './manifest.js';
import { formatOpsStatus } from './ops-status.js';
import { JsonRpcReader, manifestDigest, verifyRelease } from './release.js';
import { EscrowControlError, EXIT, type ExitCode } from './types.js';
import { asPublicKey, equalJson, readJson, redactedError, sha256, stableJson } from './util.js';

const execFileAsync = promisify(execFile);

const USAGE = `Usage: tsx scripts/escrow/cli.ts <command> [options]

Commands:
  provenance      --program-so FILE --idl FILE --source DIR --lock FILE [--source-commit COMMIT] [--out FILE]
  compare-builds  --left FILE --right FILE
  idl-policy      --idl FILE
  verify-release  --manifest FILE --program-so FILE --idl FILE --source DIR --lock FILE --rpc URL [--source-commit COMMIT]
  local-validator-evidence --program-so FILE --idl FILE --source DIR --lock FILE --operations-evidence-key-file FILE --operations-evidence-public-key KEY --out FILE [--source-commit COMMIT]
  devnet-evidence --manifest FILE --program-so FILE --idl FILE --source DIR --lock FILE --rpc URL --report FILE --out FILE [--source-commit COMMIT]
  manifest-hash   --manifest FILE
  mainnet-gate    --evidence FILE --manifest FILE --program-so FILE --idl FILE --source DIR --lock FILE --rpc URL --devnet-rpc URL [--source-commit COMMIT]
  ops-status      --input FILE

All commands are read-only except provenance/local-validator-evidence/devnet-evidence --out, which write only the requested artifact.
No command deploys, signs, submits, pauses, upgrades, or mutates chain state.`;

function parseArgs(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--') || value.startsWith('--')) {
      throw new EscrowControlError(EXIT.usage, 'options must be --name value pairs');
    }
    if (values.has(key)) throw new EscrowControlError(EXIT.usage, `duplicate option ${key}`);
    values.set(key, value);
  }
  return values;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined || value.length === 0) throw new EscrowControlError(EXIT.usage, `missing required option ${name}`);
  return value;
}

function rejectUnknown(options: Map<string, string>, allowed: readonly string[]): void {
  const unknown = [...options.keys()].filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new EscrowControlError(EXIT.usage, `unknown options: ${unknown.sort().join(', ')}`);
}

function trustedSigner(environmentName: string): string {
  const value = process.env[environmentName];
  if (value === undefined || value.length === 0) {
    throw new EscrowControlError(EXIT.gate, `protected evidence signer is not configured: ${environmentName}`);
  }
  return asPublicKey(value, environmentName);
}

async function sourceCommit(options: Map<string, string>): Promise<string> {
  const explicit = options.get('--source-commit');
  if (explicit !== undefined) return explicit;
  try {
    const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    return result.stdout.trim();
  } catch {
    throw new EscrowControlError(EXIT.input, 'cannot resolve source commit; pass --source-commit');
  }
}

function artifactPaths(options: Map<string, string>): ArtifactPaths {
  return {
    programSo: required(options, '--program-so'),
    idl: required(options, '--idl'),
    source: required(options, '--source'),
    lock: required(options, '--lock'),
  };
}

async function printJson(value: unknown, output?: string): Promise<void> {
  const rendered = stableJson(value);
  if (output === undefined) process.stdout.write(rendered);
  else await writeFile(output, rendered, { encoding: 'utf8', flag: 'wx' }).catch(() => {
    throw new EscrowControlError(EXIT.input, `refusing to overwrite or cannot create output file: ${output}`);
  });
}

async function execute(command: string, args: readonly string[]): Promise<void> {
  const options = parseArgs(args);
  switch (command) {
    case 'provenance': {
      rejectUnknown(options, ['--program-so', '--idl', '--source', '--lock', '--source-commit', '--out']);
      const manifest = await buildProvenance(await sourceCommit(options), artifactPaths(options));
      await printJson(manifest, options.get('--out'));
      return;
    }
    case 'compare-builds': {
      rejectUnknown(options, ['--left', '--right']);
      const left = parseBuildManifest(await readJson(required(options, '--left')), 'left build manifest');
      const right = parseBuildManifest(await readJson(required(options, '--right')), 'right build manifest');
      if (!equalJson(left, right)) throw new EscrowControlError(EXIT.mismatch, 'build manifests are not reproducible');
      await printJson({ ok: true, reproducible: true, manifest: left });
      return;
    }
    case 'idl-policy': {
      rejectUnknown(options, ['--idl']);
      await printJson(verifyIdlPolicy(await readJson(required(options, '--idl'))));
      return;
    }
    case 'verify-release': {
      rejectUnknown(options, ['--manifest', '--program-so', '--idl', '--source', '--lock', '--rpc', '--source-commit']);
      const manifest = parseReleaseManifest(await readJson(required(options, '--manifest')));
      const paths = artifactPaths(options);
      verifyIdlPolicy(await readJson(paths.idl));
      const build = await buildProvenance(await sourceCommit(options), paths);
      const localSbf = await readFile(paths.programSo).catch(() => {
        throw new EscrowControlError(EXIT.input, `cannot read SBF: ${paths.programSo}`);
      });
      const result = await verifyRelease(manifest, build, new JsonRpcReader(required(options, '--rpc')), localSbf);
      await printJson({ ...result, manifestSha256: manifestDigest(manifest), network: manifest.network, programId: manifest.programId });
      return;
    }
    case 'local-validator-evidence': {
      rejectUnknown(options, [
        '--program-so', '--idl',
        '--source',
        '--lock',
        '--operations-evidence-key-file',
        '--operations-evidence-public-key',
        '--source-commit',
        '--out',
      ]);
      const paths = artifactPaths(options);
      verifyIdlPolicy(await readJson(paths.idl));
      const envelope = await runLocalValidatorEvidence({
        sourceCommit: await sourceCommit(options),
        paths,
        integrationSuitePath: 'packages/escrow-integration',
        controlsPath: 'scripts/escrow',
        operationsEvidenceKeyPath: required(options, '--operations-evidence-key-file'),
        expectedOperationsPublicKey: required(options, '--operations-evidence-public-key'),
      });
      await printJson(envelope, required(options, '--out'));
      return;
    }
    case 'devnet-evidence': {
      rejectUnknown(options, ['--manifest', '--program-so', '--idl', '--source', '--lock', '--rpc', '--report', '--source-commit', '--out']);
      const manifest = parseReleaseManifest(await readJson(required(options, '--manifest')));
      const paths = artifactPaths(options);
      verifyIdlPolicy(await readJson(paths.idl));
      const build = await buildProvenance(await sourceCommit(options), paths);
      const localSbf = await readFile(paths.programSo).catch(() => {
        throw new EscrowControlError(EXIT.input, `cannot read SBF: ${paths.programSo}`);
      });
      const reportPath = required(options, '--report');
      const reportBytes = await readFile(reportPath).catch(() => {
        throw new EscrowControlError(EXIT.input, `cannot read devnet report: ${reportPath}`);
      });
      let report: unknown;
      try {
        report = JSON.parse(reportBytes.toString('utf8'));
      } catch {
        throw new EscrowControlError(EXIT.input, `invalid devnet report JSON: ${reportPath}`);
      }
      const receipt = await createDevnetEvidence({
        manifest,
        build,
        rpc: new JsonRpcReader(required(options, '--rpc')),
        localSbf,
        report,
        reportSha256: sha256(reportBytes),
      });
      await printJson(receipt, required(options, '--out'));
      return;
    }
    case 'manifest-hash': {
      rejectUnknown(options, ['--manifest']);
      const manifest = parseReleaseManifest(await readJson(required(options, '--manifest')));
      await printJson({ ok: true, manifestSha256: manifestDigest(manifest) });
      return;
    }
    case 'mainnet-gate': {
      rejectUnknown(options, [
        '--evidence',
        '--manifest',
        '--program-so',
        '--idl',
        '--source',
        '--lock',
        '--rpc',
        '--devnet-rpc',
        '--source-commit',
      ]);
      const evidencePath = required(options, '--evidence');
      const manifest = parseReleaseManifest(await readJson(required(options, '--manifest')));
      const paths = artifactPaths(options);
      const build = await buildProvenance(await sourceCommit(options), paths);
      const mainnetSbf = await readFile(paths.programSo).catch(() => {
        throw new EscrowControlError(EXIT.input, `cannot read SBF: ${paths.programSo}`);
      });
      const result = await verifyMainnetEvidence(await readJson(evidencePath), {
        manifest,
        localBuild: build,
        mainnetRpc: new JsonRpcReader(required(options, '--rpc')),
        mainnetSbf,
        mainnetIdl: await readJson(paths.idl),
        devnetRpc: new JsonRpcReader(required(options, '--devnet-rpc')),
        sourcePath: paths.source,
        lockPath: paths.lock,
        artifactRoot: dirname(resolve(evidencePath)),
        integrationSuitePath: 'packages/escrow-integration',
        controlsPath: 'scripts/escrow',
        trustedSigners: {
          operations: trustedSigner('ESCROW_OPERATIONS_EVIDENCE_PUBLIC_KEY'),
          independentReview: trustedSigner('ESCROW_REVIEW_EVIDENCE_PUBLIC_KEY'),
          externalAudit: trustedSigner('ESCROW_AUDIT_EVIDENCE_PUBLIC_KEY'),
          authority: trustedSigner('ESCROW_AUTHORITY_EVIDENCE_PUBLIC_KEY'),
          approval: trustedSigner('ESCROW_APPROVAL_EVIDENCE_PUBLIC_KEY'),
        },
      });
      await printJson(result);
      return;
    }
    case 'ops-status': {
      rejectUnknown(options, ['--input']);
      const result = formatOpsStatus(await readJson(required(options, '--input')));
      process.stdout.write(`${result.lines.join('\n')}\n`);
      if (!result.healthy) throw new EscrowControlError(EXIT.unhealthy, result.failures.join('; '));
      return;
    }
    default:
      throw new EscrowControlError(EXIT.usage, command ? `unknown command ${command}` : 'missing command');
  }
}

export async function run(argv: readonly string[]): Promise<ExitCode> {
  try {
    const [command = '', ...args] = argv;
    if (command === '--help' || command === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }
    await execute(command, args);
    return EXIT.ok;
  } catch (error) {
    const exitCode = error instanceof EscrowControlError ? error.exitCode : EXIT.internal;
    process.stderr.write(`escrow-control: ${redactedError(error)}\n`);
    if (exitCode === EXIT.usage) process.stderr.write(`${USAGE}\n`);
    return exitCode;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
