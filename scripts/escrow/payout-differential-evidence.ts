import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  asCommit,
  asInteger,
  asRecord,
  asSha256,
  asString,
  rejectExtraKeys,
  sha256,
  stableJson,
} from './util.js';
import { EscrowControlError, EXIT } from './types.js';

export const PAYOUT_DIFFERENTIAL_CORPUS = 'programs/calledit-escrow/vectors/payout-differential-v1.json';
export const PAYOUT_DIFFERENTIAL_MIN_CASES = 4_096;
export const PAYOUT_DIFFERENTIAL_GENERATOR = 'scripts/escrow/payout-differential-evidence.ts';

type DifferentialLanguage = 'rust' | 'typescript';

interface LanguageResult {
  readonly schemaVersion: 1;
  readonly language: DifferentialLanguage;
  readonly seed: string;
  readonly caseCount: number;
  readonly corpusSha256: string;
  readonly resultSha256: string;
}

export interface PayoutDifferentialEvidenceReceipt {
  readonly schemaVersion: 1;
  readonly kind: 'payout-differential-evidence';
  readonly generatedBy: typeof PAYOUT_DIFFERENTIAL_GENERATOR;
  readonly sourceCommit: string;
  readonly seed: string;
  readonly caseCount: number;
  readonly corpusPath: typeof PAYOUT_DIFFERENTIAL_CORPUS;
  readonly corpusSha256: string;
  readonly rustResultSha256: string;
  readonly typescriptResultSha256: string;
  readonly receiptSha256: string;
}

interface CorpusMetadata {
  readonly seed: string;
  readonly caseCount: number;
  readonly corpusSha256: string;
}

function fail(message: string): never {
  throw new EscrowControlError(EXIT.gate, message);
}

function seed(value: unknown, label: string): string {
  const parsed = asString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parsed)) fail(`${label} is invalid`);
  return parsed;
}

function parseCorpus(bytes: Buffer): CorpusMetadata {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    fail('payout differential corpus is not valid JSON');
  }
  const root = asRecord(value, 'payout differential corpus');
  rejectExtraKeys(root, ['schema_version', 'seed', 'case_count', 'cases'], 'payout differential corpus');
  if (asInteger(root.schema_version, 'payout differential corpus.schema_version') !== 2) {
    fail('payout differential corpus schema must be 2');
  }
  const caseCount = asInteger(root.case_count, 'payout differential corpus.case_count');
  if (caseCount < PAYOUT_DIFFERENTIAL_MIN_CASES) fail(`payout differential corpus requires at least ${PAYOUT_DIFFERENTIAL_MIN_CASES} cases`);
  if (!Array.isArray(root.cases) || root.cases.length !== caseCount) fail('payout differential corpus case count mismatch');
  return {
    seed: seed(root.seed, 'payout differential corpus.seed'),
    caseCount,
    corpusSha256: sha256(bytes),
  };
}

function parseLanguageResult(value: unknown, expectedLanguage: DifferentialLanguage): LanguageResult {
  const label = `${expectedLanguage} payout differential result`;
  const root = asRecord(value, label);
  rejectExtraKeys(root, ['schemaVersion', 'language', 'seed', 'caseCount', 'corpusSha256', 'resultSha256'], label);
  if (asInteger(root.schemaVersion, `${label}.schemaVersion`) !== 1) fail(`${label} schemaVersion must be 1`);
  if (asString(root.language, `${label}.language`) !== expectedLanguage) fail(`${label} language mismatch`);
  return {
    schemaVersion: 1,
    language: expectedLanguage,
    seed: seed(root.seed, `${label}.seed`),
    caseCount: asInteger(root.caseCount, `${label}.caseCount`),
    corpusSha256: asSha256(root.corpusSha256, `${label}.corpusSha256`),
    resultSha256: asSha256(root.resultSha256, `${label}.resultSha256`),
  };
}

function receiptDigest(value: Omit<PayoutDifferentialEvidenceReceipt, 'receiptSha256'>): string {
  return sha256(stableJson(value));
}

export function createPayoutDifferentialEvidenceReceipt(input: {
  readonly sourceCommit: string;
  readonly corpusBytes: Buffer;
  readonly rustResult: unknown;
  readonly typescriptResult: unknown;
}): PayoutDifferentialEvidenceReceipt {
  const sourceCommit = asCommit(input.sourceCommit, 'payout differential source commit');
  const corpus = parseCorpus(input.corpusBytes);
  const rust = parseLanguageResult(input.rustResult, 'rust');
  const typescript = parseLanguageResult(input.typescriptResult, 'typescript');
  for (const [label, result] of [['rust', rust], ['typescript', typescript]] as const) {
    if (result.seed !== corpus.seed) fail(`${label} payout differential seed differs from corpus`);
    if (result.caseCount !== corpus.caseCount) fail(`${label} payout differential case count differs from corpus`);
    if (result.corpusSha256 !== corpus.corpusSha256) fail(`${label} payout differential corpus digest mismatch`);
  }
  if (rust.resultSha256 !== typescript.resultSha256) fail('Rust and TypeScript payout differential result digests differ');
  const unsigned = {
    schemaVersion: 1,
    kind: 'payout-differential-evidence',
    generatedBy: PAYOUT_DIFFERENTIAL_GENERATOR,
    sourceCommit,
    seed: corpus.seed,
    caseCount: corpus.caseCount,
    corpusPath: PAYOUT_DIFFERENTIAL_CORPUS,
    corpusSha256: corpus.corpusSha256,
    rustResultSha256: rust.resultSha256,
    typescriptResultSha256: typescript.resultSha256,
  } as const;
  return { ...unsigned, receiptSha256: receiptDigest(unsigned) };
}

export function parsePayoutDifferentialEvidenceReceipt(value: unknown): PayoutDifferentialEvidenceReceipt {
  const label = 'payout differential evidence receipt';
  const root = asRecord(value, label);
  rejectExtraKeys(root, [
    'schemaVersion',
    'kind',
    'generatedBy',
    'sourceCommit',
    'seed',
    'caseCount',
    'corpusPath',
    'corpusSha256',
    'rustResultSha256',
    'typescriptResultSha256',
    'receiptSha256',
  ], label);
  if (asInteger(root.schemaVersion, `${label}.schemaVersion`) !== 1) fail(`${label} schemaVersion must be 1`);
  if (asString(root.kind, `${label}.kind`) !== 'payout-differential-evidence') fail(`${label} kind is invalid`);
  if (asString(root.generatedBy, `${label}.generatedBy`) !== PAYOUT_DIFFERENTIAL_GENERATOR) fail(`${label} producer is invalid`);
  const caseCount = asInteger(root.caseCount, `${label}.caseCount`);
  if (caseCount < PAYOUT_DIFFERENTIAL_MIN_CASES) fail(`${label} has too few cases`);
  if (asString(root.corpusPath, `${label}.corpusPath`) !== PAYOUT_DIFFERENTIAL_CORPUS) fail(`${label} corpus path is invalid`);
  const receipt = {
    schemaVersion: 1,
    kind: 'payout-differential-evidence',
    generatedBy: PAYOUT_DIFFERENTIAL_GENERATOR,
    sourceCommit: asCommit(root.sourceCommit, `${label}.sourceCommit`),
    seed: seed(root.seed, `${label}.seed`),
    caseCount,
    corpusPath: PAYOUT_DIFFERENTIAL_CORPUS,
    corpusSha256: asSha256(root.corpusSha256, `${label}.corpusSha256`),
    rustResultSha256: asSha256(root.rustResultSha256, `${label}.rustResultSha256`),
    typescriptResultSha256: asSha256(root.typescriptResultSha256, `${label}.typescriptResultSha256`),
  } as const;
  if (receipt.rustResultSha256 !== receipt.typescriptResultSha256) fail(`${label} language result digests differ`);
  const expectedDigest = receiptDigest(receipt);
  if (asSha256(root.receiptSha256, `${label}.receiptSha256`) !== expectedDigest) fail(`${label} content address mismatch`);
  return { ...receipt, receiptSha256: expectedDigest };
}

async function command(command: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(command, [...args], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolvePromise(code ?? 1));
  }).catch(() => fail('payout differential test process could not start'));
  if (exitCode !== 0) {
    const tail = stderr.split('\n').filter(Boolean).slice(-8).join('\n');
    throw new EscrowControlError(EXIT.gate, `payout differential test process exited ${exitCode}${tail ? `\n${tail}` : ''}`);
  }
}

async function resultFile(path: string, language: DifferentialLanguage): Promise<unknown> {
  const bytes = await readFile(path).catch(() => fail(`${language} payout differential result file is missing`));
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    fail(`${language} payout differential result file is invalid`);
  }
}

export async function runPayoutDifferentialEvidence(input: {
  readonly sourceCommit: string;
  readonly repositoryRoot?: string;
  readonly corpusPath?: string;
}): Promise<PayoutDifferentialEvidenceReceipt> {
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const corpusPath = resolve(repositoryRoot, input.corpusPath ?? PAYOUT_DIFFERENTIAL_CORPUS);
  const corpusBytes = await readFile(corpusPath).catch(() => fail('payout differential corpus is missing'));
  parseCorpus(corpusBytes);
  const directory = await mkdtemp(join(tmpdir(), 'calledit-payout-differential-'));
  const rustPath = join(directory, 'rust.json');
  const typescriptPath = join(directory, 'typescript.json');
  try {
    await Promise.all([
      command('cargo', [
        'test', '-p', 'calledit-escrow', '--test', 'foundation',
        'rust_matches_the_shared_typescript_differential_corpus', '--', '--exact', '--nocapture',
      ], repositoryRoot, { ...process.env, PAYOUT_DIFFERENTIAL_RUST_RESULT_PATH: rustPath }),
      command('npx', [
        '-y', 'pnpm@10.33.0', '--filter', '@calledit/escrow-sdk',
        'exec', 'vitest', 'run', 'test/payout-differential.test.ts',
      ], repositoryRoot, { ...process.env, PAYOUT_DIFFERENTIAL_TYPESCRIPT_RESULT_PATH: typescriptPath }),
    ]);
    return createPayoutDifferentialEvidenceReceipt({
      sourceCommit: input.sourceCommit,
      corpusBytes,
      rustResult: await resultFile(rustPath, 'rust'),
      typescriptResult: await resultFile(typescriptPath, 'typescript'),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
