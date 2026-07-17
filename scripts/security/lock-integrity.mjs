import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const IMPORTER_SECTIONS = [
  ['dependencies', 'dependencies'],
  ['devDependencies', 'devDependencies'],
  ['optionalDependencies', 'optionalDependencies'],
];
const REQUIRED_LOCKFILE_KEYS = new Set(['lockfileVersion', 'settings', 'importers', 'packages', 'snapshots']);
const LOCKFILE_KEYS = new Set([...REQUIRED_LOCKFILE_KEYS, 'overrides']);

export async function verifyLockIntegrity({ root = process.cwd() } = {}) {
  const absoluteRoot = resolve(root);
  const lockfilePath = join(absoluteRoot, 'pnpm-lock.yaml');
  const [lockfileText, manifests] = await Promise.all([
    readFile(lockfilePath, 'utf8'),
    discoverWorkspaceManifests(absoluteRoot),
  ]);
  const lockfile = parseLockfile(lockfileText);
  validateLockfileShape(lockfile);
  validateOverrides(lockfile.overrides, manifests[0]?.document);
  validateImporters(lockfile.importers, manifests, absoluteRoot);
  const registryPackageCount = validatePackageIntegrities(lockfile.packages);

  return {
    schema_version: 1,
    status: 'pass',
    lockfile: 'pnpm-lock.yaml',
    sha256: createHash('sha256').update(lockfileText).digest('hex'),
    workspace_count: manifests.length,
    registry_package_count: registryPackageCount,
  };
}

function parseLockfile(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new LockIntegrityError(`pnpm-lock.yaml is invalid YAML: ${document.errors[0]?.message ?? 'unknown error'}`);
  }
  const value = document.toJS();
  if (!isRecord(value)) throw new LockIntegrityError('pnpm-lock.yaml must contain an object');
  return value;
}

function validateLockfileShape(lockfile) {
  if (!hasRequiredKeys(lockfile, REQUIRED_LOCKFILE_KEYS) || !Object.keys(lockfile).every((key) => LOCKFILE_KEYS.has(key))) {
    throw new LockIntegrityError('pnpm-lock.yaml has unknown or missing top-level fields');
  }
  if (lockfile.lockfileVersion !== '9.0') {
    throw new LockIntegrityError('pnpm-lock.yaml must use lockfileVersion 9.0');
  }
  if (!isRecord(lockfile.settings)) throw new LockIntegrityError('pnpm-lock.yaml settings must be an object');
  if (lockfile.settings.autoInstallPeers !== true || lockfile.settings.excludeLinksFromLockfile !== false) {
    throw new LockIntegrityError('pnpm-lock.yaml settings must preserve the repository package-manager settings');
  }
  if (!isRecord(lockfile.importers) || !isRecord(lockfile.packages) || !isRecord(lockfile.snapshots)) {
    throw new LockIntegrityError('pnpm-lock.yaml importers, packages, and snapshots must be objects');
  }
}

function validateOverrides(lockOverrides, rootManifest) {
  if (!isRecord(rootManifest)) {
    throw new LockIntegrityError('root package.json must contain an object');
  }
  const pnpm = rootManifest.pnpm;
  if (pnpm !== undefined && !isRecord(pnpm)) {
    throw new LockIntegrityError('root package.json pnpm must be an object');
  }
  const expected = isRecord(pnpm) && pnpm.overrides !== undefined ? pnpm.overrides : {};
  if (!isRecord(expected) || !Object.values(expected).every(isNonEmptyString)) {
    throw new LockIntegrityError('root package.json pnpm.overrides must be a string map');
  }
  const actual = lockOverrides ?? {};
  if (!isRecord(actual) || !hasExactKeys(actual, new Set(Object.keys(expected)))) {
    throw new LockIntegrityError('pnpm-lock.yaml overrides must exactly match root package.json');
  }
  for (const [name, version] of Object.entries(expected)) {
    if (actual[name] !== version) {
      throw new LockIntegrityError(`pnpm-lock.yaml override ${name} does not match root package.json`);
    }
  }
}

async function discoverWorkspaceManifests(root) {
  const manifestPaths = [join(root, 'package.json')];
  for (const directory of ['apps', 'packages']) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    manifestPaths.push(
      ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, directory, entry.name, 'package.json')),
    );
  }
  return Promise.all(manifestPaths.map((path) => loadManifest(root, path)));
}

async function loadManifest(root, path) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(document)) throw new LockIntegrityError(`${relative(root, path)} must contain a JSON object`);
  const importer = relative(root, path) === 'package.json' ? '.' : relative(root, join(path, '..'));
  return { importer, path, document };
}

function validateImporters(importers, manifests, root) {
  const expectedImporters = new Set(manifests.map((manifest) => manifest.importer));
  if (!hasExactKeys(importers, expectedImporters)) {
    throw new LockIntegrityError('pnpm-lock.yaml importers must exactly match workspace manifests');
  }
  for (const manifest of manifests) {
    const importer = importers[manifest.importer];
    if (!isRecord(importer)) throw new LockIntegrityError(`lock importer ${manifest.importer} must be an object`);
    validateImporter(manifest, importer, root);
  }
}

function validateImporter(manifest, importer, root) {
  const allowedSections = new Set(IMPORTER_SECTIONS.map(([, lockSection]) => lockSection));
  if (!Object.keys(importer).every((key) => allowedSections.has(key))) {
    throw new LockIntegrityError(`lock importer ${manifest.importer} has an unsupported dependency section`);
  }
  for (const [manifestSection, lockSection] of IMPORTER_SECTIONS) {
    const expected = dependencySection(manifest.document, manifestSection, relative(root, manifest.path));
    const locked = importer[lockSection] ?? {};
    if (!isRecord(locked)) {
      throw new LockIntegrityError(`lock importer ${manifest.importer} ${lockSection} must be an object`);
    }
    if (!hasExactKeys(locked, new Set(Object.keys(expected)))) {
      throw new LockIntegrityError(`lock importer ${manifest.importer} ${lockSection} does not match its manifest`);
    }
    for (const [name, specifier] of Object.entries(expected)) {
      const lockedDependency = locked[name];
      if (!isRecord(lockedDependency) || lockedDependency.specifier !== specifier || !isNonEmptyString(lockedDependency.version)) {
        throw new LockIntegrityError(`lock importer ${manifest.importer} ${name} specifier mismatch`);
      }
    }
  }
}

function dependencySection(manifest, section, path) {
  const value = manifest[section] ?? {};
  if (!isRecord(value) || !Object.values(value).every(isNonEmptyString)) {
    throw new LockIntegrityError(`${path} ${section} must be a dependency map`);
  }
  return value;
}

function validatePackageIntegrities(packages) {
  let count = 0;
  for (const [name, record] of Object.entries(packages)) {
    if (!isRecord(record) || !isRecord(record.resolution) || !isIntegrity(record.resolution.integrity)) {
      throw new LockIntegrityError(`lock package ${name} is missing a valid integrity hash`);
    }
    count += 1;
  }
  return count;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function hasRequiredKeys(value, required) {
  return [...required].every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isIntegrity(value) {
  return typeof value === 'string' && /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u.test(value);
}

export class LockIntegrityError extends Error {}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyLockIntegrity().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${JSON.stringify({ schema_version: 1, status: 'fail', message })}\n`);
      process.exitCode = 1;
    },
  );
}
