import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENDPOINT = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

export async function collectBulkAudit({ trees, fetchImpl = fetch, endpoint = DEFAULT_ENDPOINT }) {
  const inventory = productionInventory(trees);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(inventory.payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new BulkAuditError(`bulk advisory endpoint returned HTTP ${response.status}`);

  let document;
  try {
    document = await response.json();
  } catch {
    throw new BulkAuditError('bulk advisory endpoint returned invalid JSON');
  }
  if (!isRecord(document)) throw new BulkAuditError('bulk advisory response must be an object');

  const advisories = {};
  for (const [packageName, values] of Object.entries(document)) {
    if (!inventory.paths.has(packageName) || !Array.isArray(values)) {
      throw new BulkAuditError('bulk advisory response contains an unknown package or invalid advisory list');
    }
    for (const value of values) {
      const advisory = normalizeAdvisory(packageName, value, inventory.paths.get(packageName));
      const key = String(advisory.id);
      if (advisories[key] !== undefined) {
        throw new BulkAuditError(`bulk advisory response repeats advisory ${key}`);
      }
      advisories[key] = advisory;
    }
  }
  return { advisories };
}

export function productionInventory(trees) {
  if (!Array.isArray(trees)) throw new BulkAuditError('pnpm production list must be an array');
  const versions = new Map();
  const paths = new Map();
  for (const tree of trees) {
    if (!isRecord(tree) || typeof tree.name !== 'string' || !isRecord(tree.dependencies ?? {})) {
      throw new BulkAuditError('pnpm production list contains an invalid workspace');
    }
    walkDependencies(tree.name, tree.dependencies ?? {}, [], versions, paths, new Set());
  }
  const payload = Object.fromEntries(
    [...versions].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, values]) => [name, [...values].sort()]),
  );
  return { payload, paths };
}

function walkDependencies(workspace, dependencies, ancestors, versions, paths, activeNodes) {
  for (const [name, node] of Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isRecord(node) || typeof node.version !== 'string') {
      throw new BulkAuditError(`pnpm production dependency ${name} is invalid`);
    }
    const nextPath = [...ancestors, name];
    if (isRegistryDependency(node)) {
      add(versions, name, node.version);
      add(paths, name, `${workspace}>${nextPath.join('>')}`);
    }
    if (isRecord(node.dependencies) && !activeNodes.has(node.path)) {
      const nextActive = new Set(activeNodes);
      if (typeof node.path === 'string') nextActive.add(node.path);
      walkDependencies(workspace, node.dependencies, nextPath, versions, paths, nextActive);
    }
  }
}

function isRegistryDependency(node) {
  if (typeof node.resolved !== 'string') return false;
  if (!/^https:\/\/registry\.npmjs\.org\//u.test(node.resolved)) return false;
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(node.version);
}

function normalizeAdvisory(packageName, value, dependencyPaths) {
  if (!isRecord(value)) throw new BulkAuditError('bulk advisory entry must be an object');
  const { id, severity, vulnerable_versions: vulnerableVersions } = value;
  if ((typeof id !== 'string' && typeof id !== 'number') || String(id).length === 0) {
    throw new BulkAuditError('bulk advisory entry has an invalid id');
  }
  if (typeof severity !== 'string' || typeof vulnerableVersions !== 'string') {
    throw new BulkAuditError('bulk advisory entry is missing severity or vulnerable_versions');
  }
  return {
    id,
    module_name: packageName,
    severity,
    vulnerable_versions: vulnerableVersions,
    findings: [{ paths: [...dependencyPaths].sort() }],
  };
}

function add(map, key, value) {
  const values = map.get(key) ?? new Set();
  values.add(value);
  map.set(key, values);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class BulkAuditError extends Error {}

async function main(args) {
  const inputPath = args[0];
  if (inputPath === undefined || args.length !== 1) {
    throw new BulkAuditError('Usage: node scripts/security/bulk-audit.mjs <pnpm-list.json>');
  }
  const trees = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  return collectBulkAudit({ trees });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${JSON.stringify({ schema_version: 1, status: 'invalid-input', message })}\n`);
      process.exitCode = 2;
    },
  );
}
