#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { verifyIdlPolicy } from './idl-policy.js';
import { verifyMainnetEvidence } from './mainnet-gate.js';
import { buildProvenance, parseBuildManifest, parseReleaseManifest, type ArtifactPaths } from './manifest.js';
import { formatOpsStatus } from './ops-status.js';
import { JsonRpcReader, manifestDigest, verifyRelease } from './release.js';
import { EscrowControlError, EXIT, type ExitCode } from './types.js';
import { equalJson, readJson, redactedError, stableJson } from './util.js';

const execFileAsync = promisify(execFile);

const USAGE = `Usage: tsx scripts/escrow/cli.ts <command> [options]

Commands:
  provenance      --program-so FILE --idl FILE --source DIR --lock FILE [--source-commit COMMIT] [--out FILE]
  compare-builds  --left FILE --right FILE
  idl-policy      --idl FILE
  verify-release  --manifest FILE --program-so FILE --idl FILE --source DIR --lock FILE --rpc URL [--source-commit COMMIT]
  manifest-hash   --manifest FILE
  mainnet-gate    --evidence FILE
  ops-status      --input FILE

All commands are read-only except provenance --out, which writes only the requested manifest.
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
      const build = await buildProvenance(await sourceCommit(options), paths);
      const localSbf = await readFile(paths.programSo).catch(() => {
        throw new EscrowControlError(EXIT.input, `cannot read SBF: ${paths.programSo}`);
      });
      const result = await verifyRelease(manifest, build, new JsonRpcReader(required(options, '--rpc')), localSbf);
      await printJson({ ...result, manifestSha256: manifestDigest(manifest), network: manifest.network, programId: manifest.programId });
      return;
    }
    case 'manifest-hash': {
      rejectUnknown(options, ['--manifest']);
      const manifest = parseReleaseManifest(await readJson(required(options, '--manifest')));
      await printJson({ ok: true, manifestSha256: manifestDigest(manifest) });
      return;
    }
    case 'mainnet-gate': {
      rejectUnknown(options, ['--evidence']);
      await printJson(verifyMainnetEvidence(await readJson(required(options, '--evidence'))));
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
