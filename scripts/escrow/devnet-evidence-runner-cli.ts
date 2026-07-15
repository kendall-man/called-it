#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { JsonRpcReader } from './release.js';
import { parseReleaseManifest } from './manifest.js';
import {
  DevnetEvidenceRunnerError,
  loadDevnetRoleCredentials,
  runDevnetEvidence,
  type DevnetScenarioDriver,
} from './devnet-evidence-runner.js';
import { readJson, stableJson } from './util.js';

const USAGE = `Usage:
  tsx scripts/escrow/devnet-evidence-runner-cli.ts --manifest FILE [--out FILE]
  tsx scripts/escrow/devnet-evidence-runner-cli.ts --manifest FILE --out FILE --execute

Dry-run is the default and submits no transactions. Live mode requires
ESCROW_E2E_DRIVER_MODULE and writes a devnet-e2e-report to a new --out file.
The RPC URL and every keypair path are read only from ESCROW_E2E_* environment variables.`;

interface CliOptions {
  readonly manifestPath: string;
  readonly outputPath?: string;
  readonly execute: boolean;
}

function cliFail(message: string): never {
  throw new DevnetEvidenceRunnerError(message);
}

function parseArgs(args: readonly string[]): CliOptions {
  let manifestPath: string | undefined;
  let outputPath: string | undefined;
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--execute') {
      if (execute) cliFail('duplicate --execute option');
      execute = true;
      continue;
    }
    if (argument !== '--manifest' && argument !== '--out') cliFail('unknown option; use --help for the supported interface');
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) cliFail(`${argument} requires a value`);
    index += 1;
    if (argument === '--manifest') {
      if (manifestPath !== undefined) cliFail('duplicate --manifest option');
      manifestPath = value;
    } else {
      if (outputPath !== undefined) cliFail('duplicate --out option');
      outputPath = value;
    }
  }
  if (manifestPath === undefined) cliFail('missing required --manifest option');
  if (execute && outputPath === undefined) cliFail('execute mode requires --out');
  return { manifestPath, ...(outputPath === undefined ? {} : { outputPath }), execute };
}

async function loadDriver(modulePath: string | undefined): Promise<DevnetScenarioDriver> {
  if (modulePath === undefined || modulePath.length === 0) cliFail('execute mode requires ESCROW_E2E_DRIVER_MODULE');
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(resolve(modulePath)).href);
  } catch {
    cliFail('devnet scenario driver module could not be loaded');
  }
  const factory = (loaded as { readonly createDevnetScenarioDriver?: unknown }).createDevnetScenarioDriver;
  if (typeof factory !== 'function') cliFail('driver module must export createDevnetScenarioDriver()');
  let driver: unknown;
  try {
    driver = await factory();
  } catch {
    cliFail('devnet scenario driver initialization failed without exposing sensitive details');
  }
  if (
    driver === null
    || typeof driver !== 'object'
    || typeof (driver as Partial<DevnetScenarioDriver>).execute !== 'function'
    || typeof (driver as Partial<DevnetScenarioDriver>).restoreBaseline !== 'function'
  ) {
    cliFail('driver factory returned an invalid devnet scenario driver');
  }
  return driver as DevnetScenarioDriver;
}

async function output(value: unknown, path?: string): Promise<void> {
  const rendered = stableJson(value);
  if (path === undefined) {
    process.stdout.write(rendered);
    return;
  }
  await writeFile(path, rendered, { encoding: 'utf8', flag: 'wx', mode: 0o644 }).catch(() => {
    cliFail('refusing to overwrite or unable to create the requested output file');
  });
}

export async function runCli(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const options = parseArgs(args);
    const rpcUrl = environment['ESCROW_E2E_RPC_URL'];
    if (rpcUrl === undefined || rpcUrl.length === 0) cliFail('ESCROW_E2E_RPC_URL is required');
    const manifest = parseReleaseManifest(await readJson(options.manifestPath));
    const credentials = await loadDevnetRoleCredentials(environment);
    if (options.execute) {
      await runDevnetEvidence({
        mode: 'dry-run',
        manifest,
        rpcUrl,
        rpc: new JsonRpcReader(rpcUrl),
        credentials,
      });
    }
    const driver = options.execute ? await loadDriver(environment['ESCROW_E2E_DRIVER_MODULE']) : undefined;
    const result = await runDevnetEvidence({
      mode: options.execute ? 'execute' : 'dry-run',
      manifest,
      rpcUrl,
      rpc: new JsonRpcReader(rpcUrl),
      credentials,
      ...(driver === undefined ? {} : { driver }),
    });
    await output(result, options.outputPath);
    return 0;
  } catch (error) {
    const message = error instanceof DevnetEvidenceRunnerError
      ? error.message
      : 'devnet evidence runner failed without exposing RPC or credential details';
    process.stderr.write(`devnet evidence runner: ${message}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
