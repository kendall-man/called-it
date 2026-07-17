import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAuditReport, PolicyInputError } from './dependency-policy-audit.mjs';
import {
  validateWaiverDocument,
  waiverIdentifies,
  waiverMatches,
} from './dependency-policy-waivers.mjs';

const ACTIVE_SEVERITIES = new Set(['critical', 'high', 'moderate']);
const USAGE =
  'Usage: node scripts/security/dependency-policy.mjs --audit <audit.json> [--waivers <waivers.json>] [--now <ISO-8601>]';

export function evaluateDependencyPolicy({ audit, waivers, now = new Date() }) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new PolicyInputError('now must be a valid Date');
  }
  const advisories = parseAuditReport(audit);
  const waiverValidation = validateWaiverDocument(waivers, now);
  const failures = [...waiverValidation.failures];
  validateWaiverEvidence(waiverValidation.waivers, advisories, failures);
  const findings = advisories.map((advisory) => evaluateAdvisory(advisory, waiverValidation.waivers, failures));

  return {
    schema_version: 1,
    evaluated_at: now.toISOString(),
    status: failures.length === 0 ? 'pass' : 'fail',
    advisory_count: advisories.length,
    findings,
    failures,
  };
}

function validateWaiverEvidence(waivers, advisories, failures) {
  for (const waiver of waivers) {
    const identifiedAdvisories = advisories.filter((advisory) => waiverIdentifies(waiver, advisory));
    if (identifiedAdvisories.length === 0) {
      failures.push({
        code: 'orphan-waiver',
        advisory_id: waiver.advisory_id,
        package_name: waiver.package_name,
        message: 'waiver does not match an advisory in the supplied audit report',
      });
      continue;
    }
    if (!identifiedAdvisories.some((advisory) => waiverMatches(waiver, advisory))) {
      failures.push({
        code: 'reachability-evidence-mismatch',
        advisory_id: waiver.advisory_id,
        package_name: waiver.package_name,
        message: 'waiver audit_paths must exactly match the audit dependency paths',
      });
    }
  }
}

function evaluateAdvisory(advisory, waivers, failures) {
  if (!ACTIVE_SEVERITIES.has(advisory.severity)) {
    return { ...advisory, disposition: 'not_applicable' };
  }
  const waiver = waivers.find((candidate) => waiverMatches(candidate, advisory));
  if (waiver === undefined) {
    failures.push({
      code: 'unwaived-reachable-advisory',
      advisory_id: advisory.advisory_id,
      package_name: advisory.package_name,
      message: 'active advisory has no complete, unexpired matching waiver',
    });
    return { ...advisory, disposition: 'unwaived' };
  }
  return {
    ...advisory,
    disposition: waiver.reachability.status === 'reachable' ? 'waived_reachable' : 'not_reachable',
    waiver: waiver.advisory_id,
  };
}

async function main(args) {
  const options = parseArguments(args);
  const [auditText, waiverText] = await Promise.all([
    readFile(options.audit, 'utf8'),
    readFile(options.waivers, 'utf8'),
  ]);
  return evaluateDependencyPolicy({
    audit: JSON.parse(auditText),
    waivers: JSON.parse(waiverText),
    now: options.now,
  });
}

function parseArguments(args) {
  let audit;
  let waivers = 'security/dependency-waivers.json';
  let now = new Date();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new PolicyInputError(USAGE);
    if (flag === '--audit') audit = value;
    else if (flag === '--waivers') waivers = value;
    else if (flag === '--now') {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.valueOf())) throw new PolicyInputError('--now must be ISO-8601');
      now = parsed;
    } else throw new PolicyInputError(USAGE);
  }
  if (audit === undefined) throw new PolicyInputError(USAGE);
  return { audit: resolve(audit), waivers: resolve(waivers), now };
}

export { PolicyInputError };

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status === 'fail') process.exitCode = 1;
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${JSON.stringify({ schema_version: 1, status: 'invalid-input', message })}\n`);
      process.exitCode = 2;
    },
  );
}
