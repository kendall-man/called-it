import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { evaluateDependencyPolicy } from './dependency-policy.mjs';

const NOW = new Date('2026-07-11T12:00:00.000Z');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUDIT_PATH = 'apps__engine>example-runtime';

test('fails a reachable high advisory without a waiver', () => {
  // Given
  const audit = legacyAudit({ severity: 'high' });

  // When
  const result = evaluateDependencyPolicy({ audit, waivers: waiverDocument([]), now: NOW });

  // Then
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.failures.map((failure) => failure.code), ['unwaived-reachable-advisory']);
  assert.deepEqual(result.findings[0]?.dependency_paths, [AUDIT_PATH]);
});

test('accepts an advisory proven unreachable from every shipped workspace', () => {
  // Given
  const audit = legacyAudit({ severity: 'moderate' });
  const waivers = waiverDocument([validWaiver({ reachability: unreachableReachability() })]);

  // When
  const result = evaluateDependencyPolicy({ audit, waivers, now: NOW });

  // Then
  assert.equal(result.status, 'pass');
  assert.equal(result.findings[0]?.disposition, 'not_reachable');
});

test('fails a not-reachable waiver whose evidence does not match the audit dependency path', () => {
  // Given
  const audit = legacyAudit({ severity: 'high' });
  const waivers = waiverDocument([
    validWaiver({
      reachability: unreachableReachability({ audit_paths: ['apps__fixtures>example-runtime'] }),
    }),
  ]);

  // When
  const result = evaluateDependencyPolicy({ audit, waivers, now: NOW });

  // Then
  assert.equal(result.status, 'fail');
  assert.ok(result.failures.some((failure) => failure.code === 'reachability-evidence-mismatch'));
  assert.ok(result.failures.some((failure) => failure.code === 'unwaived-reachable-advisory'));
});

test('rejects a reachability declaration without a typed basis and audit paths', () => {
  // Given
  const waiver = validWaiver({
    reachability: {
      status: 'not_reachable',
      justification: 'The package is imported only by a test fixture and never ships.',
    },
  });

  // When
  const result = evaluateDependencyPolicy({
    audit: legacyAudit({ severity: 'high' }),
    waivers: waiverDocument([waiver]),
    now: NOW,
  });

  // Then
  assert.equal(result.status, 'fail');
  assert.ok(result.failures.some((failure) => failure.code === 'invalid-waiver'));
});

test('rejects unsorted audit paths instead of normalizing waiver evidence', () => {
  // Given
  const waiver = validWaiver({
    reachability: reachableReachability({ audit_paths: ['z-path', 'a-path'] }),
  });

  // When
  const result = evaluateDependencyPolicy({
    audit: legacyAudit({ severity: 'high' }),
    waivers: waiverDocument([waiver]),
    now: NOW,
  });

  // Then
  assert.equal(result.status, 'fail');
  assert.ok(result.failures.some((failure) => failure.code === 'invalid-waiver'));
});

test('fails closed when a matching waiver has expired', () => {
  // Given
  const audit = legacyAudit({ severity: 'high' });
  const waivers = waiverDocument([validWaiver({ expires_on: '2026-07-10' })]);

  // When
  const result = evaluateDependencyPolicy({ audit, waivers, now: NOW });

  // Then
  assert.equal(result.status, 'fail');
  assert.ok(result.failures.some((failure) => failure.code === 'expired-waiver'));
  assert.ok(result.failures.some((failure) => failure.code === 'unwaived-reachable-advisory'));
});

for (const field of ['owner', 'expires_on', 'evidence_ref']) {
  test(`rejects a waiver that omits ${field}`, () => {
    // Given
    const waiver = validWaiver();
    delete waiver[field];

    // When
    const result = evaluateDependencyPolicy({
      audit: legacyAudit({ severity: 'high' }),
      waivers: waiverDocument([waiver]),
      now: NOW,
    });

    // Then
    assert.equal(result.status, 'fail');
    assert.ok(result.failures.some((failure) => failure.code === 'invalid-waiver'));
  });
}

test('rejects a waiver expiry more than thirty days away', () => {
  // Given
  const waivers = waiverDocument([validWaiver({ expires_on: '2026-08-11' })]);

  // When
  const result = evaluateDependencyPolicy({
    audit: legacyAudit({ severity: 'high' }),
    waivers,
    now: NOW,
  });

  // Then
  assert.equal(result.status, 'fail');
  assert.ok(result.failures.some((failure) => failure.code === 'invalid-waiver'));
});

test('parses npm audit vulnerability reports and permits a complete reachable waiver', () => {
  // Given
  const audit = {
    vulnerabilities: {
      'example-runtime': {
        name: 'example-runtime',
        severity: 'high',
        nodes: ['node_modules/example-runtime'],
        via: [
          {
            source: 1001,
            name: 'example-runtime',
            severity: 'high',
            range: '<2.0.0',
          },
        ],
      },
    },
  };
  const waivers = waiverDocument([
    validWaiver({
      advisory_id: '1001',
      reachability: reachableReachability({ audit_paths: ['node_modules/example-runtime'] }),
    }),
  ]);

  // When
  const result = evaluateDependencyPolicy({ audit, waivers, now: NOW });

  // Then
  assert.equal(result.status, 'pass');
  assert.equal(result.findings[0]?.disposition, 'waived_reachable');
});

test('rejects unknown waiver fields instead of silently ignoring them', () => {
  // Given
  const waiver = validWaiver();
  waiver.approved_by = 'not-permitted';

  // When
  const result = evaluateDependencyPolicy({
    audit: legacyAudit({ severity: 'high' }),
    waivers: waiverDocument([waiver]),
    now: NOW,
  });

  // Then
  assert.equal(result.status, 'fail');
  assert.ok(result.failures.some((failure) => failure.code === 'invalid-waiver'));
});

test('security workflow runs frozen install, both policy gates, and a SHA-pinned Gitleaks action', async () => {
  // Given
  const workflowPath = join(ROOT, '.github', 'workflows', 'security.yml');

  // When
  const workflow = await readFile(workflowPath, 'utf8');

  // Then
  assert.match(workflow, /pnpm@10\.33\.0 install --frozen-lockfile/);
  assert.match(workflow, /node scripts\/security\/lock-integrity\.mjs/);
  assert.match(workflow, /node scripts\/security\/dependency-policy\.mjs --audit/);
  assert.match(
    workflow,
    /gitleaks\/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7/,
  );
});

function legacyAudit({ severity }) {
  return {
    advisories: {
      GHSA_1234_5678_9ABC: {
        id: 'GHSA-1234-5678-9ABC',
        module_name: 'example-runtime',
        severity,
        vulnerable_versions: '<2.0.0',
        findings: [{ paths: [AUDIT_PATH] }],
      },
    },
  };
}

function waiverDocument(waivers) {
  return { schema_version: 1, waivers };
}

function validWaiver(overrides = {}) {
  return {
    advisory_id: 'GHSA-1234-5678-9ABC',
    package_name: 'example-runtime',
    version_range: '<2.0.0',
    reachability: {
      status: 'reachable',
      basis: 'shipped_workspace',
      justification: 'The vulnerable parser is reached by the engine production import path.',
      audit_paths: [AUDIT_PATH],
    },
    affected_paths: ['apps/engine/src/main.ts'],
    compensating_control: 'A release-blocking fix is tracked and deployments are restricted.',
    owner: 'security@example.invalid',
    issue_url: 'https://github.com/example/project/issues/1',
    evidence_ref: 'git:0123456789abcdef0123456789abcdef01234567',
    expires_on: '2026-08-10',
    ...overrides,
  };
}

function reachableReachability({ audit_paths = [AUDIT_PATH] } = {}) {
  return {
    status: 'reachable',
    basis: 'shipped_workspace',
    justification: 'The vulnerable parser is reached by the engine production import path.',
    audit_paths,
  };
}

function unreachableReachability({ audit_paths = [AUDIT_PATH] } = {}) {
  return {
    status: 'not_reachable',
    basis: 'fixture_only',
    justification: 'The package is imported only by a fixture and is absent from shipped workspaces.',
    audit_paths,
  };
}
