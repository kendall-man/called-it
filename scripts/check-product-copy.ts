import { relative, resolve } from 'node:path';
import {
  collectSourceFiles,
  readSource,
  REPO_ROOT,
  scanFile,
  TRACKED_SURFACES,
  type Surface,
  type Violation,
} from './product-copy-contract.js';

type ScanMode =
  | { readonly kind: 'tracked' }
  | { readonly kind: 'fixtures'; readonly paths: readonly string[] }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string };

const USAGE = 'Usage: check-product-copy [--fixture <path> ...]';

function parseArguments(args: readonly string[]): ScanMode {
  if (args.length === 0) return { kind: 'tracked' };
  if (args.length === 1 && args[0] === '--help') return { kind: 'help' };

  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== '--fixture' || value === undefined) {
      return { kind: 'error', message: USAGE };
    }
    paths.push(resolve(value));
  }
  return { kind: 'fixtures', paths };
}

/** One confident line, e.g. "Runs on Solana devnet — these are test tokens." */
const DEVNET_DISCLOSURE = /\bdevnet\b[^.\n]{0,80}\btest tokens\b/i;
/** Surfaces that must carry the single devnet disclosure (onboarding + receipt). */
const DISCLOSURE_SURFACES: readonly string[] = ['bot', 'web'];

function scanSurface(surface: Surface, paths: readonly string[]): number {
  const violations: Violation[] = [];
  let hasSolContract = surface.name === 'fixture';
  let hasDevnetDisclosure = !DISCLOSURE_SURFACES.includes(surface.name);

  for (const path of paths) {
    const result = readSource(path);
    if (result.kind === 'error') {
      console.error(`[input.invalid-fixture] ${path}: ${result.message}`);
      return 2;
    }
    console.log(`SCAN ${surface.name} ${relative(REPO_ROOT, path)}`);
    if (/\bSOL\b/u.test(result.contents)) hasSolContract = true;
    if (DEVNET_DISCLOSURE.test(result.contents)) hasDevnetDisclosure = true;
    violations.push(...scanFile(path, surface.name, result.contents));
  }

  if (!hasSolContract) {
    violations.push({
      file: surface.name,
      line: 0,
      ruleId: 'economy.sol-required',
      excerpt: 'Active surfaces must identify SOL or test SOL as the sole economy.',
    });
  }

  if (!hasDevnetDisclosure) {
    violations.push({
      file: surface.name,
      line: 0,
      ruleId: 'economy.devnet-disclosure-required',
      excerpt: 'Onboarding and receipt surfaces must disclose Solana devnet test tokens once.',
    });
  }

  for (const violation of violations) {
    const displayPath = violation.line === 0 ? violation.file : relative(REPO_ROOT, violation.file);
    const location = violation.line === 0 ? displayPath : `${displayPath}:${violation.line}`;
    console.log(`${location} [${violation.ruleId}] ${violation.excerpt}`);
  }

  if (violations.length > 0) {
    console.log(`FAIL ${surface.name} (${violations.length} violations)`);
    return 1;
  }
  console.log(`PASS ${surface.name} (${paths.length} ${paths.length === 1 ? 'file' : 'files'})`);
  return 0;
}

function run(args: readonly string[]): number {
  const mode = parseArguments(args);
  if (mode.kind === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (mode.kind === 'error') {
    console.error(`[input.invalid-arguments] ${mode.message}`);
    return 2;
  }

  try {
    if (mode.kind === 'fixtures') {
      return scanSurface({ name: 'fixture', entries: [] }, mode.paths);
    }

    let exitCode = 0;
    let fileCount = 0;
    for (const surface of TRACKED_SURFACES) {
      const paths = surface.entries.flatMap(collectSourceFiles);
      fileCount += paths.length;
      exitCode = Math.max(exitCode, scanSurface(surface, paths));
    }
    if (exitCode === 0) console.log(`Product copy contract: PASS (${fileCount} files)`);
    return exitCode;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[input.invalid-surface] ${error.message}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = run(process.argv.slice(2));
