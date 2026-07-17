import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TASK_9_EVIDENCE_ARTIFACT_PATHS = [
  '.omo/evidence/task-9-called-it-direct-onboarding-remediation.txt',
  '.omo/evidence/task-9-called-it-direct-onboarding-remediation.sql.tap',
] as const;

export const TELEGRAM_EVIDENCE_LEAK_RULE_ID = 'TG-009.evidence-leak';
export const TELEGRAM_EVIDENCE_MISSING_ARTIFACT_RULE_ID = 'TG-009.evidence-artifact-missing';
export const TELEGRAM_EVIDENCE_UNREADABLE_ARTIFACT_RULE_ID = 'TG-009.evidence-artifact-unreadable';

export type ForbiddenTelegramEvidencePattern = string | RegExp;

export class TelegramEvidenceCheckError extends Error {
  readonly name = 'TelegramEvidenceCheckError';

  constructor(
    readonly ruleId: string,
    readonly artifactPath: string,
  ) {
    super(`[${ruleId}] ${artifactPath}`);
  }
}

/**
 * Structural checks catch raw Telegram identifiers and payload fields. Callers
 * add their fixture-specific chat, message, callback, and text sentinels.
 */
export const DEFAULT_FORBIDDEN_TELEGRAM_EVIDENCE_PATTERNS = [
  /\b(?:msg:-?\d+:\d+|cb:[^\s"'`]+|member:-?\d+:\d+|upd:\d+:[a-z][a-z0-9_]{0,63})/u,
  /\b(?:source_key|sourceKey)\s*[:=]\s*\S+/u,
  /\b(?:chat|message|callback)(?:[_ -]?id|id)\s*[:=]\s*\S+/iu,
  /\b(?:text|callback_data)\s*[:=]\s*\S+/iu,
  /["'](?:chat|message_id|callback_query|text)["']\s*:/u,
  /fixture_restart_source/u,
] as const;

export function scanTelegramEvidence(
  artifactPaths: readonly string[],
  forbiddenPatterns: readonly ForbiddenTelegramEvidencePattern[],
): void {
  for (const artifactPath of artifactPaths) {
    const contents = readArtifact(artifactPath);
    for (const forbiddenPattern of forbiddenPatterns) {
      if (matchesForbiddenPattern(contents, forbiddenPattern)) {
        throw new TelegramEvidenceCheckError(TELEGRAM_EVIDENCE_LEAK_RULE_ID, artifactPath);
      }
    }
  }
}

export function scanTask9TelegramEvidence(
  artifactPaths: readonly string[] = TASK_9_EVIDENCE_ARTIFACT_PATHS,
): void {
  scanTelegramEvidence(artifactPaths, DEFAULT_FORBIDDEN_TELEGRAM_EVIDENCE_PATTERNS);
}

function readArtifact(artifactPath: string): string {
  try {
    return readFileSync(artifactPath, 'utf8');
  } catch (error) {
    const ruleId = isMissingFileError(error)
      ? TELEGRAM_EVIDENCE_MISSING_ARTIFACT_RULE_ID
      : TELEGRAM_EVIDENCE_UNREADABLE_ARTIFACT_RULE_ID;
    throw new TelegramEvidenceCheckError(ruleId, artifactPath);
  }
}

function matchesForbiddenPattern(
  contents: string,
  forbiddenPattern: ForbiddenTelegramEvidencePattern,
): boolean {
  if (typeof forbiddenPattern === 'string') {
    return contents.includes(forbiddenPattern);
  }
  return new RegExp(forbiddenPattern.source, forbiddenPattern.flags).test(contents);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

const USAGE = 'Usage: check-telegram-evidence [evidence.txt evidence.sql.tap]';

function runCli(args: readonly string[]): number {
  const artifactPaths = parseArtifactPaths(args);
  if (artifactPaths === undefined) {
    console.error(USAGE);
    return 2;
  }

  try {
    scanTask9TelegramEvidence(artifactPaths);
    return 0;
  } catch (error) {
    if (error instanceof TelegramEvidenceCheckError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

function parseArtifactPaths(args: readonly string[]): readonly string[] | undefined {
  if (args.length === 0) return TASK_9_EVIDENCE_ARTIFACT_PATHS;
  if (args.length === TASK_9_EVIDENCE_ARTIFACT_PATHS.length) return args;
  return undefined;
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;
}

if (isMainModule()) {
  process.exitCode = runCli(process.argv.slice(2));
}
