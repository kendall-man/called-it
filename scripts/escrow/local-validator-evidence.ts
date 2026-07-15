import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';

import {
  createLocalValidatorEvidence,
  evidenceSigningPayload,
  releaseIdentity,
  type LocalValidatorEvidenceReceipt,
  type ReleaseIdentity,
} from './evidence.js';
import type { ArtifactPaths } from './manifest.js';
import { buildProvenance } from './manifest.js';
import { captureReleaseManifest, JsonRpcReader, verifyRelease } from './release.js';
import { EscrowControlError, EXIT } from './types.js';
import { asPublicKey, encodeBase58, sha256, sha256File, sha256Tree, stableJson } from './util.js';

const LOCAL_RPC_URL = 'http://127.0.0.1:18999';
const DEPLOYED_PROGRAM_ARTIFACT = '/private/tmp/calledit-beta-artifacts/calledit_escrow.so';
const RUN_TIMEOUT_MS = 6 * 60 * 1_000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface LocalValidatorEvidenceEnvelope {
  readonly schemaVersion: 1;
  readonly kind: 'machine-evidence-envelope';
  readonly releaseIdentity: ReleaseIdentity;
  readonly outputSha256: string;
  readonly output: LocalValidatorEvidenceReceipt;
  readonly signerPublicKey: string;
  readonly signature: string;
}

function signingFailure(message: string): never {
  throw new EscrowControlError(EXIT.gate, message);
}

async function operationsEvidenceSigner(
  keyPath: string,
  expectedPublicKeyValue: string,
): Promise<{ readonly privateKey: KeyObject; readonly publicKey: string }> {
  const expectedPublicKey = asPublicKey(expectedPublicKeyValue, 'configured operations evidence public key');
  const file = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    signingFailure('operations evidence key file is missing or unreadable');
  });
  let keyBytes: Buffer | undefined;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) signingFailure('operations evidence key path must be a regular file');
    if ((metadata.mode & 0o777) !== 0o600) signingFailure('operations evidence key file must have mode 0600');
    keyBytes = await file.readFile();
  } finally {
    await file.close();
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(keyBytes);
  } catch {
    signingFailure('operations evidence key file does not contain a valid private key');
  } finally {
    keyBytes.fill(0);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') signingFailure('operations evidence key must be Ed25519');
  const publicKeyDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (
    publicKeyDer.length !== ED25519_SPKI_PREFIX.length + 32
    || !publicKeyDer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    signingFailure('operations evidence key has an invalid Ed25519 public key');
  }
  const publicKey = encodeBase58(publicKeyDer.subarray(ED25519_SPKI_PREFIX.length));
  if (publicKey !== expectedPublicKey) {
    signingFailure('operations evidence key does not match the configured operations evidence public key');
  }
  return { privateKey, publicKey };
}

export async function createLocalValidatorEvidenceEnvelope(input: {
  readonly output: LocalValidatorEvidenceReceipt;
  readonly operationsEvidenceKeyPath: string;
  readonly expectedOperationsPublicKey: string;
}): Promise<LocalValidatorEvidenceEnvelope> {
  const signer = await operationsEvidenceSigner(
    input.operationsEvidenceKeyPath,
    input.expectedOperationsPublicKey,
  );
  const unsigned = {
    schemaVersion: 1,
    kind: 'machine-evidence-envelope',
    releaseIdentity: releaseIdentity(input.output.releaseManifest),
    outputSha256: sha256(stableJson(input.output)),
    output: input.output,
    signerPublicKey: signer.publicKey,
  } as const;
  return {
    ...unsigned,
    signature: encodeBase58(sign(null, evidenceSigningPayload(unsigned), signer.privateKey)),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function runLocalValidatorEvidence(input: {
  readonly sourceCommit: string;
  readonly paths: ArtifactPaths;
  readonly integrationSuitePath: string;
  readonly controlsPath: string;
  readonly operationsEvidenceKeyPath: string;
  readonly expectedOperationsPublicKey: string;
}): Promise<LocalValidatorEvidenceEnvelope> {
  const [build, requestedSbfSha256, deployedSbfSha256] = await Promise.all([
    buildProvenance(input.sourceCommit, input.paths),
    sha256File(input.paths.programSo),
    sha256File(DEPLOYED_PROGRAM_ARTIFACT).catch(() => {
      throw new EscrowControlError(EXIT.input, `local-validator deployed artifact is missing: ${DEPLOYED_PROGRAM_ARTIFACT}`);
    }),
  ]);
  if (requestedSbfSha256 !== deployedSbfSha256) {
    throw new EscrowControlError(EXIT.mismatch, 'local-validator runner artifact differs from --program-so');
  }
  const localSbf = await readFile(input.paths.programSo);
  const startedAt = new Date().toISOString();
  const child = spawn('npx', [
    '-y',
    'pnpm@10.33.0',
    '--filter',
    '@calledit/escrow-integration',
    'test:local',
  ], {
    cwd: process.cwd(),
    env: process.env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  const exit = new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolvePromise(code ?? 1));
  });
  const rpc = new JsonRpcReader(LOCAL_RPC_URL);
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let captured: Awaited<ReturnType<typeof captureReleaseManifest>> | undefined;
  let verificationChecks: readonly string[] | undefined;
  let lastCaptureError: unknown;
  while (captured === undefined && child.exitCode === null && Date.now() < deadline) {
    try {
      const manifest = await captureReleaseManifest('localnet', build, rpc);
      const verification = await verifyRelease(manifest, build, rpc, localSbf);
      captured = manifest;
      verificationChecks = verification.checks;
    } catch (error) {
      lastCaptureError = error instanceof Error ? error : new EscrowControlError(EXIT.gate, 'unknown local-validator capture failure');
      await delay(250);
    }
  }
  if (Date.now() >= deadline && child.exitCode === null) child.kill('SIGTERM');
  const exitCode = await exit;
  if (exitCode !== 0) throw new EscrowControlError(EXIT.gate, `local-validator integration exited with code ${exitCode}`);
  if (captured === undefined || verificationChecks === undefined) {
    const detail = lastCaptureError instanceof Error ? `: ${lastCaptureError.message}` : '';
    throw new EscrowControlError(EXIT.gate, `local-validator release identity could not be captured${detail}`);
  }
  const completedAt = new Date().toISOString();
  const [suiteSha256, controlsSha256] = await Promise.all([
    sha256Tree(input.integrationSuitePath),
    sha256Tree(input.controlsPath),
  ]);
  const output = createLocalValidatorEvidence({
    releaseManifest: captured,
    verificationChecks,
    suiteSha256,
    controlsSha256,
    startedAt,
    completedAt,
    verifiedAt: completedAt,
  });
  return createLocalValidatorEvidenceEnvelope({
    output,
    operationsEvidenceKeyPath: input.operationsEvidenceKeyPath,
    expectedOperationsPublicKey: input.expectedOperationsPublicKey,
  });
}
