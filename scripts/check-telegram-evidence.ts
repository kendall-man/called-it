import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const TELEGRAM_EVIDENCE_FILES = [
  '.omo/evidence/task-9-called-it-direct-onboarding-remediation.txt',
  '.omo/evidence/task-9-called-it-direct-onboarding-remediation.sql.tap',
] as const;

const FORBIDDEN_EVIDENCE_PATTERNS = [
  ['raw_source_key', /(?:msg:-?\d+:\d+|cb:[A-Za-z0-9_-]{8,}|member:-?\d+:\d+|upd:\d+:[a-z_]+)/],
  ['fixture_source', /fixture_restart_source/],
  ['raw_telegram_payload', /(?:"update_id"|"message_id"|"callback_query")/],
] as const;

export type TelegramEvidenceViolation = {
  readonly rule: string;
  readonly path: string;
};

export async function checkTelegramEvidence(root = process.cwd()): Promise<readonly TelegramEvidenceViolation[]> {
  const violations: TelegramEvidenceViolation[] = [];
  for (const relativePath of TELEGRAM_EVIDENCE_FILES) {
    const path = resolve(root, relativePath);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      violations.push({ rule: 'artifact_missing', path: relativePath });
      continue;
    }
    for (const [rule, pattern] of FORBIDDEN_EVIDENCE_PATTERNS) {
      if (pattern.test(content)) violations.push({ rule, path: relativePath });
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const violations = await checkTelegramEvidence();
  if (violations.length === 0) return;
  for (const violation of violations) {
    process.stderr.write(`telegram evidence policy violation: ${violation.rule} in ${violation.path}\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  void main();
}
