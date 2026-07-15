import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { createLocalValidatorEvidence, type LocalValidatorEvidenceReceipt } from './evidence.js';
import type { ArtifactPaths } from './manifest.js';
import { buildProvenance } from './manifest.js';
import { captureReleaseManifest, JsonRpcReader, verifyRelease } from './release.js';
import { EscrowControlError, EXIT } from './types.js';
import { sha256File, sha256Tree } from './util.js';

const LOCAL_RPC_URL = 'http://127.0.0.1:18999';
const DEPLOYED_PROGRAM_ARTIFACT = '/private/tmp/calledit-beta-artifacts/calledit_escrow.so';
const RUN_TIMEOUT_MS = 6 * 60 * 1_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function runLocalValidatorEvidence(input: {
  readonly sourceCommit: string;
  readonly paths: ArtifactPaths;
  readonly integrationSuitePath: string;
  readonly controlsPath: string;
}): Promise<LocalValidatorEvidenceReceipt> {
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
      lastCaptureError = error;
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
  return createLocalValidatorEvidence({
    releaseManifest: captured,
    verificationChecks,
    suiteSha256,
    controlsSha256,
    startedAt,
    completedAt,
    verifiedAt: completedAt,
  });
}
