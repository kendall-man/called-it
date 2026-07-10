export function parseAuditReport(document) {
  if (!isRecord(document)) throw new PolicyInputError('audit report must be a JSON object');
  const hasLegacyAdvisories = document.advisories !== undefined;
  const hasModernVulnerabilities = document.vulnerabilities !== undefined;
  if (hasLegacyAdvisories === hasModernVulnerabilities) {
    throw new PolicyInputError('audit report must contain exactly one of advisories or vulnerabilities');
  }
  const advisories = hasLegacyAdvisories
    ? parseLegacyAdvisories(document.advisories)
    : parseModernVulnerabilities(document.vulnerabilities);
  return advisories.sort(compareAdvisories);
}

function parseLegacyAdvisories(value) {
  if (!isRecord(value)) throw new PolicyInputError('audit advisories must be an object');
  return Object.values(value).map((advisory) => {
    if (!isRecord(advisory)) throw new PolicyInputError('audit advisory must be an object');
    return createAdvisory({
      advisoryId: advisory.id,
      packageName: advisory.module_name,
      severity: advisory.severity,
      versionRange: advisory.vulnerable_versions,
      dependencyPaths: advisory.findings,
    });
  });
}

function parseModernVulnerabilities(value) {
  if (!isRecord(value)) throw new PolicyInputError('audit vulnerabilities must be an object');
  return Object.entries(value).flatMap(([packageName, vulnerability]) => {
    if (!isRecord(vulnerability)) throw new PolicyInputError('audit vulnerability must be an object');
    if (!Array.isArray(vulnerability.via)) {
      throw new PolicyInputError(`audit vulnerability ${packageName} must include a via array`);
    }
    return vulnerability.via.map((via) => {
      if (!isRecord(via)) {
        throw new PolicyInputError(`audit vulnerability ${packageName} has an unidentified advisory`);
      }
      return createAdvisory({
        advisoryId: via.source,
        packageName,
        severity: via.severity ?? vulnerability.severity,
        versionRange: via.range ?? vulnerability.range,
        dependencyPaths: vulnerability.nodes,
      });
    });
  });
}

function createAdvisory({ advisoryId, packageName, severity, versionRange, dependencyPaths }) {
  if (!isIdentifier(advisoryId)) throw new PolicyInputError('audit advisory has an invalid identifier');
  if (!isPackageName(packageName)) throw new PolicyInputError('audit advisory has an invalid package name');
  if (!isVersionRange(versionRange)) throw new PolicyInputError('audit advisory has an invalid vulnerable version range');
  const normalizedSeverity = normalizeSeverity(severity);
  if (normalizedSeverity === undefined) throw new PolicyInputError('audit advisory has an unknown severity');
  return {
    advisory_id: String(advisoryId),
    package_name: packageName,
    severity: normalizedSeverity,
    version_range: versionRange.trim(),
    dependency_paths: normalizeDependencyPaths(dependencyPaths),
  };
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isIdentifier(value) {
  return (typeof value === 'string' || typeof value === 'number') && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(String(value));
}

export function isPackageName(value) {
  return typeof value === 'string' && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value);
}

export function isVersionRange(value) {
  return typeof value === 'string' && value.length <= 256 && /\d/u.test(value) && /^[0-9A-Za-z*+<>=~^|.\-\s]+$/u.test(value);
}

function normalizeSeverity(value) {
  if (typeof value !== 'string') return undefined;
  const severity = value.toLowerCase();
  return ['critical', 'high', 'moderate', 'low', 'info', 'none'].includes(severity) ? severity : undefined;
}

function normalizeDependencyPaths(value) {
  if (!Array.isArray(value)) return [];
  const paths = value.flatMap((entry) => (isRecord(entry) && Array.isArray(entry.paths) ? entry.paths : [entry]));
  return [...new Set(paths.filter((path) => typeof path === 'string' && path.length > 0))].sort();
}

function compareAdvisories(left, right) {
  return `${left.advisory_id}:${left.package_name}`.localeCompare(`${right.advisory_id}:${right.package_name}`);
}

export class PolicyInputError extends Error {}
