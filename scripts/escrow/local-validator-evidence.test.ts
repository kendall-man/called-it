import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createLocalValidatorEvidence,
  parseLocalValidatorEvidence,
  releaseIdentity,
  verifyEvidenceSignature,
  type LocalValidatorEvidenceReceipt,
} from './evidence.js';
import { createLocalValidatorEvidenceEnvelope } from './local-validator-evidence.js';
import { parseReleaseManifest } from './manifest.js';
import { createPayoutDifferentialEvidenceReceipt } from './payout-differential-evidence.js';
import { encodeBase58, sha256, stableJson } from './util.js';

const RELEASE_CHECKS = [
  'local build provenance',
  'program/build identity',
  'RPC cluster genesis',
  'program-data address',
  'upgrade authority',
  'deployed SBF bytes',
  'decoded protocol config',
  'decoded 2-of-3 oracle set',
  'canonical USDC mint layout',
  'separate operational authorities',
  'oracle signer independence',
] as const;

interface TestSigner {
  readonly privateKeyPem: string;
  readonly publicKey: string;
}

function testSigner(): TestSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: encodeBase58(publicKeyDer.subarray(-32)),
  };
}

async function sampleReceipt(): Promise<LocalValidatorEvidenceReceipt> {
  const raw: unknown = JSON.parse(await readFile(new URL('./fixtures/release-manifest.example.json', import.meta.url), 'utf8'));
  const corpusBytes = await readFile(new URL('../../programs/calledit-escrow/vectors/payout-differential-v1.json', import.meta.url));
  const corpus = JSON.parse(corpusBytes.toString('utf8')) as { seed: string; case_count: number };
  const language = (name: 'rust' | 'typescript') => ({
    schemaVersion: 1,
    language: name,
    seed: corpus.seed,
    caseCount: corpus.case_count,
    corpusSha256: sha256(corpusBytes),
    resultSha256: '7'.repeat(64),
  });
  return createLocalValidatorEvidence({
    releaseManifest: parseReleaseManifest(raw),
    verificationChecks: RELEASE_CHECKS,
    suiteSha256: '5'.repeat(64),
    controlsSha256: '6'.repeat(64),
    payoutDifferential: createPayoutDifferentialEvidenceReceipt({
      sourceCommit: 'a'.repeat(40),
      corpusBytes,
      rustResult: language('rust'),
      typescriptResult: language('typescript'),
    }),
    startedAt: '2026-07-15T10:00:00.000Z',
    completedAt: '2026-07-15T10:01:00.000Z',
  });
}

test('creates a valid machine-evidence envelope from the exact local-validator receipt', async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), 'calledit-local-evidence-'));
  const keyPath = join(directory, 'operations-evidence.pem');
  const signer = testSigner();
  const output = await sampleReceipt();
  await writeFile(keyPath, signer.privateKeyPem, { mode: 0o600 });

  try {
    // When
    const envelope = await createLocalValidatorEvidenceEnvelope({
      output,
      operationsEvidenceKeyPath: keyPath,
      expectedOperationsPublicKey: signer.publicKey,
    });

    // Then
    assert.deepEqual(envelope.output, output);
    assert.deepEqual(envelope.releaseIdentity, releaseIdentity(output.releaseManifest));
    assert.equal(envelope.outputSha256, sha256(stableJson(output)));
    verifyEvidenceSignature({ ...envelope }, signer.publicKey, 'local-validator evidence machine evidence envelope');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when the operations evidence key file is missing', async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), 'calledit-local-evidence-'));
  const signer = testSigner();
  const output = await sampleReceipt();

  try {
    // When / Then
    await assert.rejects(
      createLocalValidatorEvidenceEnvelope({
        output,
        operationsEvidenceKeyPath: join(directory, 'missing.pem'),
        expectedOperationsPublicKey: signer.publicKey,
      }),
      /operations evidence key file is missing or unreadable/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when the operations evidence key file is not mode 0600', async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), 'calledit-local-evidence-'));
  const keyPath = join(directory, 'operations-evidence.pem');
  const signer = testSigner();
  const output = await sampleReceipt();
  await writeFile(keyPath, signer.privateKeyPem, { mode: 0o640 });

  try {
    // When / Then
    await assert.rejects(
      createLocalValidatorEvidenceEnvelope({
        output,
        operationsEvidenceKeyPath: keyPath,
        expectedOperationsPublicKey: signer.publicKey,
      }),
      /operations evidence key file must have mode 0600/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when the operations evidence key does not match the configured public key', async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), 'calledit-local-evidence-'));
  const keyPath = join(directory, 'operations-evidence.pem');
  const signer = testSigner();
  const otherSigner = testSigner();
  const output = await sampleReceipt();
  await writeFile(keyPath, signer.privateKeyPem, { mode: 0o600 });

  try {
    // When / Then
    await assert.rejects(
      createLocalValidatorEvidenceEnvelope({
        output,
        operationsEvidenceKeyPath: keyPath,
        expectedOperationsPublicKey: otherSigner.publicKey,
      }),
      /does not match the configured operations evidence public key/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('detects tampering with signed local-validator output', async () => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), 'calledit-local-evidence-'));
  const keyPath = join(directory, 'operations-evidence.pem');
  const signer = testSigner();
  const output = await sampleReceipt();
  await writeFile(keyPath, signer.privateKeyPem, { mode: 0o600 });

  try {
    const envelope = await createLocalValidatorEvidenceEnvelope({
      output,
      operationsEvidenceKeyPath: keyPath,
      expectedOperationsPublicKey: signer.publicKey,
    });

    // When
    const tampered = {
      ...envelope,
      output: { ...envelope.output, suiteSha256: '7'.repeat(64) },
    };

    // Then
    assert.throws(
      () => verifyEvidenceSignature(tampered, signer.publicKey, 'local-validator evidence machine evidence envelope'),
      /signature is invalid/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local-validator evidence requires payout differential receipt', async () => {
  const output = await sampleReceipt();
  const missing = Object.fromEntries(
    Object.entries(output).filter(([field]) => field !== 'payoutDifferential'),
  );
  assert.throws(
    () => parseLocalValidatorEvidence(missing),
    /payout differential evidence receipt must be an object/,
  );
});
