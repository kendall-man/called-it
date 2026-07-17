import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

export type SurfaceName = 'guidance' | 'bot' | 'concierge' | 'web' | 'fixture';

export type Surface = {
  readonly name: SurfaceName;
  readonly entries: readonly string[];
};

type Rule = {
  readonly id: string;
  readonly pattern: RegExp;
  readonly policyScope: 'none' | 'contracts' | 'all';
  readonly fileWide?: boolean;
  readonly surfaces?: readonly SurfaceName[];
};

export type Violation = {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly excerpt: string;
};

export type ReadResult =
  | { readonly kind: 'ok'; readonly contents: string }
  | { readonly kind: 'error'; readonly message: string };

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const SOURCE_EXTENSIONS = new Set(['.md', '.ts', '.tsx']);
const POLICY_CONTEXT =
  /\b(?:do not|does not support|must not|never|avoid|forbidden|excluded)\b|\bno\s+(?:active\s+|current\s+)?(?:rep|points?|demo|replay|cash(?:\s|-)?out|stack|real[- ](?:money|value))\b|\bno\b.{0,80}\bpoints?\s+(?:balance|leaderboard|economy)\b|\bnot\s+(?:real money|part of|a current|supported|allowed)\b/i;
const HISTORICAL_CONTEXT =
  /\b(?:removed|retired|historical|legacy|dormant|migration)\b/i;
const ACTIVE_COPY_SURFACES: readonly SurfaceName[] = ['bot', 'concierge', 'web', 'fixture'];

export const TRACKED_SURFACES: readonly Surface[] = [
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
    entries: [
      'apps/engine/src/bot/bot.ts',
      'apps/engine/src/bot/commands.ts',
      'apps/engine/src/bot/copy.ts',
      'apps/engine/src/bot/fallback-copy.ts',
      'apps/engine/src/wager/copy.ts',
      'packages/agent/src/templates.ts',
    ],
  },
  {
    name: 'concierge',
    entries: ['apps/concierge/agent/instructions', 'apps/concierge/agent/tools'],
  },
  {
    name: 'web',
    entries: ['apps/web/app', 'apps/web/components', 'apps/web/lib/spec-terms.ts'],
  },
];

const RULES: readonly Rule[] = [
  {
    id: 'receipt.aggregate-primary-path',
    pattern: /\baggregate\s+receipt\b/iu,
    policyScope: 'none',
    fileWide: true,
    surfaces: ACTIVE_COPY_SURFACES,
  },
  {
    id: 'economy.rep-primary-path',
    pattern: /\brep\b/i,
    policyScope: 'contracts',
  },
  {
    id: 'economy.points-primary-path',
    pattern: /\bpoints?\b.{0,48}\b(?:balance|economy|leaderboard|stake|wager)\b/i,
    policyScope: 'contracts',
  },
  {
    id: 'onboarding.demo-or-replay',
    pattern:
      /(?:\B\/replay\b|\.command\(\s*['"]replay['"]|\bcommand\s*:\s*['"]replay['"]|\b(?:demo|replay)\s+(?:group|market|mode|onboarding|tutorial|walkthrough)\b|\b(?:join|run|start|try|watch)\b.{0,40}\b(?:demo|replay)\b)/i,
    policyScope: 'contracts',
  },
  {
    id: 'starter.misleading-funds',
    pattern: /\bstarter\b.{0,80}\b(?:demo|free money|practice|real money|real value)\b/i,
    policyScope: 'contracts',
  },
  {
    id: 'value.real-money-claim',
    pattern:
      /(?:\breal\s+(?:devnet\s+)?sol\b|\breal[- ]money\b|\breal[- ]value\b|\b(?:carries?|has|holds?|represents?)\s+(?:real\s+)?monetary value\b|\bworth\s+(?:money|sol)\b)/i,
    policyScope: 'all',
  },
  {
    id: 'language.cashout',
    pattern: /\bcash(?:\s|-)?out\b/i,
    policyScope: 'contracts',
  },
  {
    id: 'language.stack',
    pattern: /\bstack\b/i,
    policyScope: 'contracts',
  },
  {
    id: 'cta.placeholder-href',
    pattern:
      /(?:\bhref|\b[a-z_$][\w$]*(?:url|href))\s*=\s*(?:\{\s*)?["']#[^"']*["']/i,
    policyScope: 'none',
  },
];

export function collectSourceFiles(entry: string): readonly string[] {
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

export function readSource(path: string): ReadResult {
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

function contextAllowed(
  rule: Rule,
  path: string,
  surface: SurfaceName,
  line: string,
  previousLine: string,
): boolean {
  if (rule.policyScope === 'none') return false;
  if (HISTORICAL_CONTEXT.test(line) || HISTORICAL_CONTEXT.test(previousLine)) return true;
  if (!POLICY_CONTEXT.test(line)) return false;
  if (rule.policyScope === 'all') return true;
  if (surface === 'guidance') return true;
  return (
    surface === 'concierge' &&
    relative(REPO_ROOT, path).startsWith('apps/concierge/agent/instructions/')
  );
}

export function scanFile(
  path: string,
  surface: SurfaceName,
  contents: string,
): readonly Violation[] {
  const violations: Violation[] = [];
  const lines = contents.split(/\r?\n/u);
  for (const rule of RULES) {
    if (rule.surfaces !== undefined && !rule.surfaces.includes(surface)) continue;
    if (rule.fileWide === true) {
      const flags = rule.pattern.global ? rule.pattern.flags : `${rule.pattern.flags}g`;
      const matcher = new RegExp(rule.pattern.source, flags);
      for (const match of contents.matchAll(matcher)) {
        const lineIndex = contents.slice(0, match.index).split(/\r?\n/u).length - 1;
        const line = lines[lineIndex] ?? '';
        const previousLine = lineIndex === 0 ? '' : (lines[lineIndex - 1] ?? '');
        if (contextAllowed(rule, path, surface, line, previousLine)) continue;
        violations.push({
          file: path,
          line: lineIndex + 1,
          ruleId: rule.id,
          excerpt: match[0].replace(/\s+/gu, ' ').trim().slice(0, 160),
        });
      }
      continue;
    }
    for (const [index, line] of lines.entries()) {
      const previousLine = index === 0 ? '' : (lines[index - 1] ?? '');
      if (!rule.pattern.test(line)) continue;
      if (contextAllowed(rule, path, surface, line, previousLine)) continue;
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
