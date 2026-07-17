import { createHash } from 'node:crypto';

export const RECONCILIATION_SOURCES = ['queue', 'readiness', 'settlement', 'wallet'] as const;
export const RECONCILIATION_REASON_CODES = [
  'no_action',
  'queue_backlog',
  'queue_stalled',
  'readiness_failed',
  'settlement_missing',
  'settlement_mismatch',
  'wallet_intent_expired',
  'wallet_intent_missing',
] as const;

export type ReconciliationSource = (typeof RECONCILIATION_SOURCES)[number];
export type ReconciliationReasonCode = (typeof RECONCILIATION_REASON_CODES)[number];

export type ReconciliationFinding = {
  readonly source: ReconciliationSource;
  readonly reason_code: ReconciliationReasonCode;
  readonly count: number;
};

export type ReconciliationReadAdapter = {
  readonly readFindings: () => Promise<readonly ReconciliationFinding[]>;
};

export type ReconciliationOptions = {
  readonly environment: string;
  readonly releaseCommit: string;
  readonly asOf: string;
};

export type ReconciliationReport = {
  readonly schema_version: 1;
  readonly mode: 'dry_run';
  readonly environment: string;
  readonly release_commit: string;
  readonly as_of: string;
  readonly findings: readonly ReconciliationFinding[];
  readonly plan_hash: string;
};

export class ReconciliationContractError extends Error {
  override readonly name = 'ReconciliationContractError';

  constructor(readonly reasonCode: 'invalid_finding' | 'invalid_options') {
    super(reasonCode);
  }
}

export async function runReconciliation(
  adapter: ReconciliationReadAdapter,
  options: ReconciliationOptions,
): Promise<ReconciliationReport> {
  validateOptions(options);
  const findings = summarizeFindings(await adapter.readFindings());
  const reportWithoutHash = {
    schema_version: 1 as const,
    mode: 'dry_run' as const,
    environment: options.environment,
    release_commit: options.releaseCommit,
    as_of: canonicalTimestamp(options.asOf),
    findings,
  };
  return {
    ...reportWithoutHash,
    plan_hash: createHash('sha256').update(JSON.stringify(reportWithoutHash), 'utf8').digest('hex'),
  };
}

export function parseReconciliationFindings(value: unknown): readonly ReconciliationFinding[] | null {
  if (!Array.isArray(value)) return null;
  const findings: ReconciliationFinding[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const source = candidate.source;
    const reasonCode = candidate.reason_code;
    const count = candidate.count;
    if (!isSource(source) || !isReasonCode(reasonCode) || !isCount(count)) return null;
    findings.push({ source, reason_code: reasonCode, count });
  }
  return findings;
}

function summarizeFindings(findings: readonly ReconciliationFinding[]): readonly ReconciliationFinding[] {
  const totals = new Map<string, number>();
  for (const finding of findings) {
    if (!isSource(finding.source) || !isReasonCode(finding.reason_code) || !isCount(finding.count)) {
      throw new ReconciliationContractError('invalid_finding');
    }
    const key = `${finding.source}:${finding.reason_code}`;
    totals.set(key, (totals.get(key) ?? 0) + finding.count);
  }

  return [...totals.entries()]
    .map(([key, count]) => {
      const [source, reasonCode] = key.split(':');
      if (!isSource(source) || !isReasonCode(reasonCode)) throw new ReconciliationContractError('invalid_finding');
      return { source, reason_code: reasonCode, count };
    })
    .sort((left, right) => left.source.localeCompare(right.source)
      || left.reason_code.localeCompare(right.reason_code));
}

function validateOptions(options: ReconciliationOptions): void {
  if (!isCommit(options.releaseCommit) || !isEnvironment(options.environment)
    || Number.isNaN(new Date(options.asOf).getTime())) {
    throw new ReconciliationContractError('invalid_options');
  }
}

function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function isSource(value: unknown): value is ReconciliationSource {
  return typeof value === 'string' && RECONCILIATION_SOURCES.some((source) => source === value);
}

function isReasonCode(value: unknown): value is ReconciliationReasonCode {
  return typeof value === 'string' && RECONCILIATION_REASON_CODES.some((reasonCode) => reasonCode === value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

function isCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/u.test(value);
}

function isEnvironment(value: string): boolean {
  return /^(?:development|staging|production-canary)$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
