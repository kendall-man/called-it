#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { runPayoutDifferentialEvidence } from './payout-differential-evidence.js';
import { EscrowControlError } from './types.js';
import { stableJson } from './util.js';

const execFileAsync = promisify(execFile);

async function sourceCommit(explicit?: string): Promise<string> {
  if (explicit !== undefined) return explicit;
  try {
    return (await execFileAsync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
  } catch {
    throw new Error('cannot resolve source commit; pass --source-commit');
  }
}

function options(args: readonly string[]): { readonly output: string; readonly sourceCommit?: string } {
  let output: string | undefined;
  let commit: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error('options must be --name value pairs');
    if (key === '--out') output = value;
    else if (key === '--source-commit') commit = value;
    else throw new Error('unknown option');
  }
  if (output === undefined) throw new Error('--out is required');
  return { output, ...(commit === undefined ? {} : { sourceCommit: commit }) };
}

export async function run(args: readonly string[]): Promise<number> {
  try {
    const parsed = options(args);
    const receipt = await runPayoutDifferentialEvidence({ sourceCommit: await sourceCommit(parsed.sourceCommit) });
    await writeFile(parsed.output, stableJson(receipt), { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    process.stdout.write(`${receipt.receiptSha256}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof EscrowControlError || error instanceof Error
      ? error.message
      : 'payout differential evidence failed';
    process.stderr.write(`payout-differential-evidence: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; });
}
