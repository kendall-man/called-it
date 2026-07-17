import type { RestoreReportViolation } from './report-contract.js';

export type JsonRecord = Readonly<Record<string, unknown>>;

export class ReportIssues {
  readonly values: RestoreReportViolation[] = [];

  add(path: string, message: string): void {
    this.values.push({ path, message });
  }
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown, path: string, issues: ReportIssues): JsonRecord | undefined {
  if (isRecord(value)) return value;
  issues.add(path, 'must be an object');
  return undefined;
}

export function recordAt(
  parent: JsonRecord,
  key: string,
  path: string,
  issues: ReportIssues,
): JsonRecord | undefined {
  return record(parent[key], path, issues);
}

export function arrayAt(
  parent: JsonRecord,
  key: string,
  path: string,
  issues: ReportIssues,
): readonly unknown[] | undefined {
  const value = parent[key];
  if (Array.isArray(value)) return value;
  issues.add(path, 'must be an array');
  return undefined;
}

export function stringAt(
  parent: JsonRecord,
  key: string,
  path: string,
  issues: ReportIssues,
): string | undefined {
  const value = parent[key];
  if (typeof value === 'string' && value.length > 0) return value;
  issues.add(path, 'must be a non-empty string');
  return undefined;
}

export function booleanAt(
  parent: JsonRecord,
  key: string,
  path: string,
  issues: ReportIssues,
): boolean | undefined {
  const value = parent[key];
  if (typeof value === 'boolean') return value;
  issues.add(path, 'must be a boolean');
  return undefined;
}

export function wholeNumberAt(
  parent: JsonRecord,
  key: string,
  path: string,
  issues: ReportIssues,
): number | undefined {
  const value = parent[key];
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  issues.add(path, 'must be a non-negative safe integer');
  return undefined;
}

export function statusAt(parent: JsonRecord, path: string, issues: ReportIssues): void {
  const status = stringAt(parent, 'status', `${path}.status`, issues);
  if (status !== undefined && status !== 'match') issues.add(`${path}.status`, 'must equal match');
}

export function sha256At(
  parent: JsonRecord,
  key: string,
  path: string,
  issues: ReportIssues,
): string | undefined {
  const value = stringAt(parent, key, path, issues);
  if (value !== undefined && !/^[a-f0-9]{64}$/i.test(value)) {
    issues.add(path, 'must be a SHA-256 digest');
  }
  return value;
}

export function isoTimeAt(
  parent: JsonRecord,
  key: string,
  path: string,
  issues: ReportIssues,
): number | undefined {
  const value = stringAt(parent, key, path, issues);
  if (value === undefined) return undefined;
  const epoch = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(epoch)) {
    issues.add(path, 'must be an ISO-8601 timestamp');
    return undefined;
  }
  return epoch;
}

export function equal(
  source: string | number | undefined,
  target: string | number | undefined,
  path: string,
  issues: ReportIssues,
): void {
  if (source !== undefined && target !== undefined && source !== target) {
    issues.add(path, 'source and target values differ');
  }
}
