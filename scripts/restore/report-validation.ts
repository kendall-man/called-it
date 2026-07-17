import type { RestoreReportValidation } from './report-contract.js';
import { validateComparisons } from './report-comparisons.js';
import { ReportIssues, record } from './report-primitives.js';
import { validateSafetyAndRollback } from './report-safety.js';

export function validateRestoreReport(input: unknown): RestoreReportValidation {
  const issues = new ReportIssues();
  const report = record(input, '$', issues);
  if (report === undefined) return { kind: 'invalid', violations: issues.values };
  validateSafetyAndRollback(report, issues);
  validateComparisons(report, issues);
  return issues.values.length === 0
    ? { kind: 'valid' }
    : { kind: 'invalid', violations: issues.values };
}
