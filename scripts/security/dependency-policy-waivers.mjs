import { isIdentifier, isPackageName, isRecord, isVersionRange } from './dependency-policy-audit.mjs';

const WAIVER_KEYS = new Set([
  'advisory_id',
  'package_name',
  'version_range',
  'reachability',
  'affected_paths',
  'compensating_control',
  'owner',
  'issue_url',
  'evidence_ref',
  'expires_on',
]);
const REACHABILITY_KEYS = new Set(['status', 'basis', 'justification', 'audit_paths']);

export function validateWaiverDocument(document, now) {
  const failures = [];
  if (!isRecord(document)) {
    return { waivers: [], failures: [invalidWaiver('waiver document must be a JSON object')] };
  }
  if (!hasExactKeys(document, new Set(['schema_version', 'waivers']))) {
    failures.push(invalidWaiver('waiver document has unknown or missing fields'));
  }
  if (document.schema_version !== 1) failures.push(invalidWaiver('waiver document schema_version must equal 1'));
  if (!Array.isArray(document.waivers)) {
    failures.push(invalidWaiver('waiver document waivers must be an array'));
    return { waivers: [], failures };
  }

  const waivers = [];
  const keys = new Set();
  for (const candidate of document.waivers) {
    const validation = validateWaiver(candidate, now);
    if (validation.failure !== undefined) {
      failures.push(validation.failure);
      continue;
    }
    const waiver = validation.waiver;
    const key = `${waiver.advisory_id}:${waiver.package_name}`;
    if (keys.has(key)) {
      failures.push(invalidWaiver('duplicate waiver advisory_id and package_name pair', waiver));
      continue;
    }
    keys.add(key);
    waivers.push(waiver);
  }
  return { waivers, failures };
}

export function waiverMatches(waiver, advisory) {
  return waiverIdentifies(waiver, advisory) && samePaths(waiver.reachability.audit_paths, advisory.dependency_paths);
}

export function waiverIdentifies(waiver, advisory) {
  return (
    waiver.advisory_id === advisory.advisory_id &&
    waiver.package_name === advisory.package_name &&
    waiver.version_range === advisory.version_range
  );
}

function validateWaiver(candidate, now) {
  if (!isRecord(candidate) || !hasExactKeys(candidate, WAIVER_KEYS)) {
    return { failure: invalidWaiver('waiver has unknown or missing fields', candidate) };
  }
  if (!isIdentifier(candidate.advisory_id)) {
    return { failure: invalidWaiver('waiver advisory_id is invalid', candidate) };
  }
  if (!isPackageName(candidate.package_name)) {
    return { failure: invalidWaiver('waiver package_name is invalid', candidate) };
  }
  if (!isVersionRange(candidate.version_range)) {
    return { failure: invalidWaiver('waiver version_range is invalid', candidate) };
  }
  if (!isReachability(candidate.reachability)) {
    return { failure: invalidWaiver('waiver reachability is invalid', candidate) };
  }
  if (!isPathList(candidate.affected_paths)) {
    return { failure: invalidWaiver('waiver affected_paths must be non-empty relative paths', candidate) };
  }
  if (!isExplanation(candidate.compensating_control) || !isShortText(candidate.owner)) {
    return { failure: invalidWaiver('waiver compensating_control and owner are required', candidate) };
  }
  if (!isHttpsUrl(candidate.issue_url)) {
    return { failure: invalidWaiver('waiver issue_url must be an HTTPS URL', candidate) };
  }
  if (!isEvidenceReference(candidate.evidence_ref)) {
    return { failure: invalidWaiver('waiver evidence_ref must be a git or sha256 reference', candidate) };
  }

  const expiry = parseDate(candidate.expires_on);
  if (expiry === undefined) return { failure: invalidWaiver('waiver expires_on must be YYYY-MM-DD', candidate) };
  const nowDay = utcDay(now);
  if (expiry < nowDay) return { failure: expiredWaiver(candidate) };
  if (expiry > nowDay + 30 * 24 * 60 * 60 * 1000) {
    return { failure: invalidWaiver('waiver expires_on may not be more than thirty days away', candidate) };
  }
  return { waiver: candidate };
}

function invalidWaiver(message, candidate = undefined) {
  return {
    code: 'invalid-waiver',
    advisory_id: isRecord(candidate) && typeof candidate.advisory_id === 'string' ? candidate.advisory_id : null,
    package_name: isRecord(candidate) && typeof candidate.package_name === 'string' ? candidate.package_name : null,
    message,
  };
}

function expiredWaiver(waiver) {
  return {
    code: 'expired-waiver',
    advisory_id: waiver.advisory_id,
    package_name: waiver.package_name,
    message: 'waiver expiry has passed',
  };
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function isReachability(value) {
  const basisMatchesStatus =
    (value?.status === 'reachable' && value.basis === 'shipped_workspace') ||
    (value?.status === 'not_reachable' && ['fixture_only', 'test_only', 'dead_package'].includes(value.basis));
  return (
    isRecord(value) &&
    hasExactKeys(value, REACHABILITY_KEYS) &&
    basisMatchesStatus &&
    isExplanation(value.justification) &&
    isAuditPathList(value.audit_paths)
  );
}

function samePaths(left, right) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function isPathList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((path) => typeof path === 'string' && /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@-]+$/u.test(path))
  );
}

function isAuditPathList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(
      (path, index) =>
        typeof path === 'string' &&
        path.length <= 500 &&
        !/[\u0000-\u001f]/u.test(path) &&
        (index === 0 || value[index - 1] < path),
    )
  );
}

function isShortText(value) {
  return typeof value === 'string' && value.trim().length >= 3 && value.length <= 500;
}

function isExplanation(value) {
  return typeof value === 'string' && value.trim().length >= 20 && value.length <= 500;
}

function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname !== '';
  } catch {
    return false;
  }
}

function isEvidenceReference(value) {
  return typeof value === 'string' && /^(?:git:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/u.test(value);
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value ? undefined : date.valueOf();
}

function utcDay(value) {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}
