import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type SurfaceName = 'guidance' | 'bot' | 'concierge' | 'web' | 'fixture';

type Surface = {
  readonly name: SurfaceName;
  readonly entries: readonly string[];
};

type Rule = {
  readonly id: string;
  readonly pattern: RegExp;
  readonly surfaces?: ReadonlySet<SurfaceName>;
  readonly allowPolicyContext: boolean;
};

type Violation = {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly excerpt: string;
};

type ReadResult =
  | { readonly kind: 'ok'; readonly contents: string }
  | { readonly kind: 'error'; readonly message: string };

type ScanMode =
  | { readonly kind: 'tracked' }
  | { readonly kind: 'fixtures'; readonly paths: readonly string[] }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: check-product-copy [--fixture <path> ...]';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const SOURCE_EXTENSIONS = new Set(['.md', '.ts', '.tsx']);
const POLICY_CONTEXT =
  /\b(?:do not|does not|must not|never|no|not|removed|retired|historical|legacy|dormant)\b/i;
const ADJACENT_POLICY_CONTEXT =
  /\b(?:do not|must not|never|removed|retired|historical|legacy|dormant)\b/i;

const TRACKED_SURFACES: readonly Surface[] = [
  {
    name: 'guidance',
    entries: [
      'README.md',
      'DESIGN.md',
      'CONTRACTS.md',
      'AGENTS.md',
      'apps/engine/AGENTS.md',
      'apps/concierge/AGENTS.md',
      'apps/web/AGENTS.md',
      'docs/PRD-called-it-mvp.md',
      'docs/eve-concierge-plan.md',
    ],
  },
  {
    name: 'bot',
    entries: ['apps/engine/src/wager/copy.ts'],
  },
  {
    name: 'concierge',
    entries: ['apps/concierge/agent/instructions'],
  },
  {
    name: 'web',
    entries: ['apps/web/app', 'apps/web/components', 'apps/web/lib/spec-terms.ts'],
  },
];

const RULES: readonly Rule[] = [
  {
    id: 'economy.rep-primary-path',
    pattern: /\brep\b/i,
    allowPolicyContext: true,
  },
  {
    id: 'economy.points-primary-path',
    pattern: /\bpoints?\b.{0,48}\b(?:balance|economy|leaderboard|stake|wager)\b/i,
    allowPolicyContext: true,
  },
  {
    id: 'onboarding.demo-or-replay',
    pattern:
      /(?:\B\/replay\b|\b(?:demo|replay)\s+(?:group|market|mode|onboarding|tutorial|walkthrough)\b|\b(?:join|run|start|try|watch)\b.{0,40}\b(?:demo|replay)\b)/i,
    surfaces: new Set(['guidance', 'concierge']),
    allowPolicyContext: true,
  },
  {
    id: 'starter.misleading-funds',
    pattern: /\bstarter\b.{0,80}\b(?:demo|free money|practice|real money|real value)\b/i,
    allowPolicyContext: true,
  },
  {
    id: 'value.real-money-claim',
    pattern:
      /(?:\breal[- ]money\b|\breal[- ]value\b|\b(?:carries?|has|holds?|represents?)\s+(?:real\s+)?monetary value\b|\bworth\s+(?:money|sol)\b)/i,
    allowPolicyContext: true,
  },
  {
    id: 'cta.placeholder-href',
    pattern: /href\s*=\s*["']#["']/i,
    allowPolicyContext: false,
  },
];

function parseArguments(args: readonly string[]): ScanMode {
  if (args.length === 0) return { kind: 'tracked' };
  if (args.length === 1 && args[0] === '--help') return { kind: 'help' };

  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== '--fixture' || value === undefined) {
      return {
        kind: 'error',
        message: USAGE,
      };
    }
    paths.push(resolve(value));
  }
  return { kind: 'fixtures', paths };
}

function collectSourceFiles(entry: string): readonly string[] {
  const absoluteEntry = resolve(REPO_ROOT, entry);
  const stats = statSync(absoluteEntry);
  if (stats.isFile()) return [absoluteEntry];

  const files: string[] = [];
  for (const child of readdirSync(absoluteEntry, { withFileTypes: true })) {
    const childPath = resolve(absoluteEntry, child.name);
    if (child.isDirectory()) {
      files.push(...collectSourceFiles(relative(REPO_ROOT, childPath)));
    } else if (
      child.isFile() &&
      SOURCE_EXTENSIONS.has(extname(child.name)) &&
      !child.name.includes('.test.')
    ) {
      files.push(childPath);
    }
  }
  return files.sort();
}

function readSource(path: string): ReadResult {
  try {
    if (!statSync(path).isFile()) {
      return { kind: 'error', message: 'path is not a regular file' };
    }
    return { kind: 'ok', contents: UTF8_DECODER.decode(readFileSync(path)) };
  } catch (error) {
    if (error instanceof Error) return { kind: 'error', message: error.message };
    throw error;
  }
}

function ruleApplies(rule: Rule, surface: SurfaceName): boolean {
  return surface === 'fixture' || rule.surfaces === undefined || rule.surfaces.has(surface);
}

function scanFile(path: string, surface: SurfaceName, contents: string): readonly Violation[] {
  const violations: Violation[] = [];
  const lines = contents.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const previousLine = index === 0 ? '' : (lines[index - 1] ?? '');
    for (const rule of RULES) {
      if (!ruleApplies(rule, surface) || !rule.pattern.test(line)) continue;
      if (
        rule.allowPolicyContext &&
        (POLICY_CONTEXT.test(line) || ADJACENT_POLICY_CONTEXT.test(previousLine))
      ) {
        continue;
      }
      violations.push({
        file: path,
        line: index + 1,
        ruleId: rule.id,
        excerpt: line.trim().slice(0, 160),
      });
    }
  }
  return violations;
}

function scanSurface(surface: Surface, paths: readonly string[]): number {
  const violations: Violation[] = [];
  let hasSolContract = surface.name === 'fixture';

  for (const path of paths) {
    const result = readSource(path);
    if (result.kind === 'error') {
      console.error(`[input.invalid-fixture] ${path}: ${result.message}`);
      return 2;
    }
    if (/\bSOL\b/u.test(result.contents)) hasSolContract = true;
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
