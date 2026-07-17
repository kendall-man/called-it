import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  STAGING_PROMOTION_INPUT_JSON_SCHEMA,
  createPromotionManifest,
  type PromotionManifest,
} from './contract.js';
import { collectSourceEvidence } from './source-evidence.js';

type CliArguments = {
  readonly configPath: string | undefined;
  readonly outputPath: string | undefined;
  readonly root: string;
  readonly schemaOnly: boolean;
};

export async function runPromotionPreflight(root: string, input: unknown): Promise<PromotionManifest> {
  return createPromotionManifest(input, await collectSourceEvidence(root));
}

async function main(arguments_: readonly string[]): Promise<void> {
  const cli = parseArguments(arguments_);
  if (cli.schemaOnly) {
    await writeOutput(cli.outputPath, STAGING_PROMOTION_INPUT_JSON_SCHEMA);
    return;
  }
  if (cli.configPath === undefined) throw new Error('--config is required unless --schema is used');
  const parsed = JSON.parse(await readFile(cli.configPath, 'utf8'));
  const input: unknown = parsed;
  const manifest = await runPromotionPreflight(cli.root, input);
  await writeOutput(cli.outputPath, manifest);
}

function parseArguments(values: readonly string[]): CliArguments {
  let configPath: string | undefined;
  let outputPath: string | undefined;
  let root = process.cwd();
  let schemaOnly = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    switch (value) {
      case '--config':
        configPath = requiredArgument(values, index, '--config');
        index += 1;
        break;
      case '--output':
        outputPath = requiredArgument(values, index, '--output');
        index += 1;
        break;
      case '--root':
        root = requiredArgument(values, index, '--root');
        index += 1;
        break;
      case '--schema':
        schemaOnly = true;
        break;
      default:
        throw new Error(`unknown argument: ${value ?? ''}`);
    }
  }
  if (schemaOnly && configPath !== undefined) throw new Error('--schema cannot be combined with --config');
  return { configPath, outputPath, root, schemaOnly };
}

function requiredArgument(values: readonly string[], index: number, flag: string): string {
  const value = values[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a path`);
  return value;
}

async function writeOutput(outputPath: string | undefined, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (outputPath === undefined) {
    process.stdout.write(serialized);
    return;
  }
  await writeFile(outputPath, serialized, 'utf8');
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
