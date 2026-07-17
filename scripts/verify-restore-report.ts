import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { RestoreReportValidation } from './restore/report-contract.js';
import { validateRestoreReport } from './restore/report-validation.js';

type VerifierOutput =
  | { readonly schema_version: 1; readonly status: 'valid' }
  | {
      readonly schema_version: 1;
      readonly status: 'invalid';
      readonly violations: readonly { readonly path: string; readonly message: string }[];
    }
  | { readonly schema_version: 1; readonly status: 'invalid_input'; readonly message: string };

export async function verifyRestoreReportFile(path: string): Promise<RestoreReportValidation> {
  const source = await readFile(path, 'utf8');
  return validateRestoreReport(parseJson(source));
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return { invalid_json: true };
    throw error;
  }
}

async function main(arguments_: readonly string[]): Promise<void> {
  if (arguments_.length !== 1) {
    writeInvalidInput('usage: tsx scripts/verify-restore-report.ts <redacted-report.json>');
    return;
  }
  const path = arguments_[0];
  if (path === undefined) {
    writeInvalidInput('missing report path');
    return;
  }
  const validation = await verifyRestoreReportFile(path);
  writeValidation(validation);
}

function writeValidation(validation: RestoreReportValidation): void {
  switch (validation.kind) {
    case 'valid':
      process.stdout.write(`${JSON.stringify({ schema_version: 1, status: 'valid' } satisfies VerifierOutput)}\n`);
      return;
    case 'invalid':
      process.stderr.write(
        `${JSON.stringify({ schema_version: 1, status: 'invalid', violations: validation.violations } satisfies VerifierOutput)}\n`,
      );
      process.exitCode = 1;
      return;
  }
}

function writeInvalidInput(message: string): void {
  process.stderr.write(`${JSON.stringify({ schema_version: 1, status: 'invalid_input', message } satisfies VerifierOutput)}\n`);
  process.exitCode = 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unexpected verifier failure';
    writeInvalidInput(message);
  });
}
