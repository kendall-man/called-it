import assert from 'node:assert/strict';
import test from 'node:test';

import { BulkAuditError, collectBulkAudit, productionInventory } from './bulk-audit.mjs';

const trees = [{
  name: '@calledit/engine',
  path: '/repo/apps/engine',
  private: true,
  dependencies: {
    '@calledit/db': {
      version: 'link:../../packages/db',
      path: '/repo/packages/db',
      dependencies: {
        zod: registry('3.25.76', '/repo/node_modules/zod'),
      },
    },
    grammy: {
      ...registry('1.44.0', '/repo/node_modules/grammy'),
      dependencies: { zod: registry('3.25.76', '/repo/node_modules/zod') },
    },
  },
}];

test('builds a deterministic production-only bulk payload and dependency paths', () => {
  const inventory = productionInventory(trees);
  assert.deepEqual(inventory.payload, { grammy: ['1.44.0'], zod: ['3.25.76'] });
  assert.deepEqual([...inventory.paths.get('zod')].sort(), [
    '@calledit/engine>@calledit/db>zod',
    '@calledit/engine>grammy>zod',
  ]);
});

test('normalizes bulk advisories into the existing fail-closed policy contract', async () => {
  let request;
  const report = await collectBulkAudit({
    trees,
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return response({ grammy: [{
        id: 1234,
        severity: 'high',
        vulnerable_versions: '<1.45.0',
        title: 'fixture advisory',
        url: 'https://example.invalid/advisory',
      }] });
    },
  });
  assert.deepEqual(request, { grammy: ['1.44.0'], zod: ['3.25.76'] });
  assert.deepEqual(report, { advisories: { 1234: {
    id: 1234,
    module_name: 'grammy',
    severity: 'high',
    vulnerable_versions: '<1.45.0',
    findings: [{ paths: ['@calledit/engine>grammy'] }],
  } } });
});

test('fails closed on endpoint errors, malformed JSON, and unknown packages', async () => {
  await assert.rejects(
    collectBulkAudit({ trees, fetchImpl: async () => response({}, 503) }),
    new BulkAuditError('bulk advisory endpoint returned HTTP 503'),
  );
  await assert.rejects(
    collectBulkAudit({ trees, fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new Error('bad'); } }) }),
    new BulkAuditError('bulk advisory endpoint returned invalid JSON'),
  );
  await assert.rejects(
    collectBulkAudit({ trees, fetchImpl: async () => response({ surprise: [] }) }),
    new BulkAuditError('bulk advisory response contains an unknown package or invalid advisory list'),
  );
});

function registry(version, path) {
  const packageName = path.split('/').at(-1);
  return {
    version,
    path,
    resolved: `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`,
  };
}

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return value; } };
}
