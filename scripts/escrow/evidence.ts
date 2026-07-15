import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { parseReleaseManifest } from './manifest.js';
import { manifestDigest, verifyRelease } from './release.js';
import type {
  BuildManifest,
  EvidenceRpcReader,
  ReleaseManifest,
} from './types.js';
import { EscrowControlError, EXIT } from './types.js';
import {
  asInteger,
  asCommit,
  asPublicKey,
  asRecord,
  asSha256,
  asString,
  decodeBase58,
  equalJson,
  rejectExtraKeys,
  sha256,
  stableJson,
} from './util.js';

export const LOCAL_VALIDATOR_RUNNER = '@calledit/escrow-integration:test:local';
export const DEVNET_SCENARIOS = [
  'real-sol-position',
  'real-usdc-position',
  'settlement-and-claim',
  'direct-claim-engine-down',
  'paused-timeout-void',
  'relayer-retry-recovery',
  'telegram-privy-receipt',
] as const;

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
const SIGNING_DOMAIN = 'calledit-escrow-release-evidence-v2';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface ReleaseIdentity {
  readonly network: ReleaseManifest['network'];
  readonly clusterGenesisHash: string;
  readonly programId: string;
  readonly sourceCommit: string;
  readonly sbfSha256: string;
  readonly idlSha256: string;
  readonly sourceSha256: string;
  readonly lockSha256: string;
  readonly buildManifestSha256: string;
  readonly releaseManifestSha256: string;
}

export interface DevnetScenario {
  readonly id: (typeof DEVNET_SCENARIOS)[number];
  readonly transactionSignature: string;
  readonly observedAt: string;
}

export interface DevnetE2eReport {
  readonly schemaVersion: 1;
  readonly kind: 'devnet-e2e-report';
  readonly releaseIdentity: ReleaseIdentity;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly runId: string;
  readonly scenarios: readonly DevnetScenario[];
}

export interface DevnetEvidenceReceipt {
  readonly schemaVersion: 1;
  readonly kind: 'devnet-e2e';
  readonly generatedBy: 'scripts/escrow/cli.ts devnet-evidence';
  readonly releaseManifest: ReleaseManifest;
  readonly releaseManifestSha256: string;
  readonly buildManifestSha256: string;
  readonly reportSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly verifiedAt: string;
  readonly runId: string;
  readonly scenarios: readonly DevnetScenario[];
  readonly verificationChecks: readonly string[];
}

export interface LocalValidatorEvidenceReceipt {
  readonly schemaVersion: 1;
  readonly kind: 'local-validator';
  readonly generatedBy: 'scripts/escrow/cli.ts local-validator-evidence';
  readonly runner: typeof LOCAL_VALIDATOR_RUNNER;
  readonly releaseManifest: ReleaseManifest;
  readonly releaseManifestSha256: string;
  readonly buildManifestSha256: string;
  readonly suiteSha256: string;
  readonly controlsSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly verifiedAt: string;
  readonly verificationChecks: readonly string[];
}

function evidenceInput(message: string): never {
  throw new EscrowControlError(EXIT.gate, message);
}

export function isoTimestamp(value: unknown, label: string): string {
  const text = asString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text) || Number.isNaN(Date.parse(text))) {
    evidenceInput(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return text;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) evidenceInput(`${label} must be an array`);
  return value.map((entry, index) => asString(entry, `${label}[${index}]`));
}

function assertTimeOrder(startedAt: string, completedAt: string, label: string): void {
  if (Date.parse(startedAt) > Date.parse(completedAt)) evidenceInput(`${label} completes before it starts`);
  if (Date.parse(completedAt) - Date.parse(startedAt) > 4 * 60 * 60 * 1_000) {
    evidenceInput(`${label} duration exceeds four hours`);
  }
}

export function buildManifestDigest(build: BuildManifest): string {
  return sha256(stableJson(build));
}

export function releaseIdentity(manifest: ReleaseManifest): ReleaseIdentity {
  return {
    network: manifest.network,
    clusterGenesisHash: manifest.clusterGenesisHash,
    programId: manifest.programId,
    sourceCommit: manifest.build.sourceCommit,
    sbfSha256: manifest.build.sbfSha256,
    idlSha256: manifest.build.idlSha256,
    sourceSha256: manifest.build.sourceSha256,
    lockSha256: manifest.build.lockSha256,
    buildManifestSha256: buildManifestDigest(manifest.build),
    releaseManifestSha256: manifestDigest(manifest),
  };
}

export function parseReleaseIdentity(value: unknown, label: string): ReleaseIdentity {
  const record = asRecord(value, label);
  rejectExtraKeys(record, [
    'network',
    'clusterGenesisHash',
    'programId',
    'sourceCommit',
    'sbfSha256',
    'idlSha256',
    'sourceSha256',
    'lockSha256',
    'buildManifestSha256',
    'releaseManifestSha256',
  ], label);
  const network = asString(record.network, `${label}.network`);
  if (!['localnet', 'devnet', 'testnet', 'mainnet-beta'].includes(network)) evidenceInput(`${label}.network is unsupported`);
  return {
    network: network as ReleaseIdentity['network'],
    clusterGenesisHash: asPublicKey(record.clusterGenesisHash, `${label}.clusterGenesisHash`),
    programId: asPublicKey(record.programId, `${label}.programId`),
    sourceCommit: asCommit(record.sourceCommit, `${label}.sourceCommit`),
    sbfSha256: asSha256(record.sbfSha256, `${label}.sbfSha256`),
    idlSha256: asSha256(record.idlSha256, `${label}.idlSha256`),
    sourceSha256: asSha256(record.sourceSha256, `${label}.sourceSha256`),
    lockSha256: asSha256(record.lockSha256, `${label}.lockSha256`),
    buildManifestSha256: asSha256(record.buildManifestSha256, `${label}.buildManifestSha256`),
    releaseManifestSha256: asSha256(record.releaseManifestSha256, `${label}.releaseManifestSha256`),
  };
}

function assertReleaseChecks(checks: readonly string[], label: string): void {
  if (new Set(checks).size !== checks.length) evidenceInput(`${label} contains duplicate checks`);
  for (const required of RELEASE_CHECKS) {
    if (!checks.includes(required)) evidenceInput(`${label} is missing ${required}`);
  }
}

export function parseDevnetE2eReport(value: unknown): DevnetE2eReport {
  const root = asRecord(value, 'devnet E2E report');
  rejectExtraKeys(root, ['schemaVersion', 'kind', 'releaseIdentity', 'startedAt', 'completedAt', 'runId', 'scenarios'], 'devnet E2E report');
  if (asInteger(root.schemaVersion, 'devnet E2E report.schemaVersion') !== 1) evidenceInput('devnet E2E report schemaVersion must be 1');
  if (asString(root.kind, 'devnet E2E report.kind') !== 'devnet-e2e-report') evidenceInput('devnet E2E report kind is invalid');
  const identity = parseReleaseIdentity(root.releaseIdentity, 'devnet E2E report.releaseIdentity');
  if (identity.network !== 'devnet') evidenceInput('devnet E2E report is not bound to devnet');
  const startedAt = isoTimestamp(root.startedAt, 'devnet E2E report.startedAt');
  const completedAt = isoTimestamp(root.completedAt, 'devnet E2E report.completedAt');
  assertTimeOrder(startedAt, completedAt, 'devnet E2E report');
  if (!Array.isArray(root.scenarios)) evidenceInput('devnet E2E report scenarios must be an array');
  const scenarios = root.scenarios.map((value, index) => {
    const label = `devnet E2E report.scenarios[${index}]`;
    const record = asRecord(value, label);
    rejectExtraKeys(record, ['id', 'transactionSignature', 'observedAt'], label);
    const id = asString(record.id, `${label}.id`);
    if (!DEVNET_SCENARIOS.includes(id as DevnetScenario['id'])) evidenceInput(`${label}.id is unsupported`);
    const transactionSignature = asString(record.transactionSignature, `${label}.transactionSignature`);
    if (decodeBase58(transactionSignature).length !== 64) evidenceInput(`${label}.transactionSignature must decode to 64 bytes`);
    return {
      id: id as DevnetScenario['id'],
      transactionSignature,
      observedAt: isoTimestamp(record.observedAt, `${label}.observedAt`),
    };
  });
  const ids = scenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length || DEVNET_SCENARIOS.some((id) => !ids.includes(id))) {
    evidenceInput('devnet E2E report must contain every required scenario exactly once');
  }
  const signatures = scenarios.map((scenario) => scenario.transactionSignature);
  if (new Set(signatures).size !== signatures.length) evidenceInput('devnet E2E scenario transaction signatures must be unique');
  for (const scenario of scenarios) {
    const observed = Date.parse(scenario.observedAt);
    if (observed < Date.parse(startedAt) || observed > Date.parse(completedAt)) {
      evidenceInput(`devnet E2E ${scenario.id} observation is outside the run window`);
    }
  }
  return {
    schemaVersion: 1,
    kind: 'devnet-e2e-report',
    releaseIdentity: identity,
    startedAt,
    completedAt,
    runId: asString(root.runId, 'devnet E2E report.runId'),
    scenarios,
  };
}

export async function verifyDevnetTransactions(
  report: DevnetE2eReport,
  rpc: EvidenceRpcReader,
): Promise<void> {
  const earliest = Date.parse(report.startedAt) / 1_000 - 3_600;
  const latest = Date.parse(report.completedAt) / 1_000 + 3_600;
  await Promise.all(report.scenarios.map(async (scenario) => {
    const transaction = await rpc.finalizedTransaction(scenario.transactionSignature);
    if (!transaction.accountKeys.includes(report.releaseIdentity.programId)) {
      evidenceInput(`devnet E2E ${scenario.id} transaction does not invoke the release program`);
    }
    if (transaction.blockTime < earliest || transaction.blockTime > latest) {
      evidenceInput(`devnet E2E ${scenario.id} transaction is outside the recorded run window`);
    }
  }));
}

export async function createDevnetEvidence(input: {
  readonly manifest: ReleaseManifest;
  readonly build: BuildManifest;
  readonly rpc: EvidenceRpcReader;
  readonly localSbf: Uint8Array;
  readonly report: unknown;
  readonly reportSha256: string;
  readonly verifiedAt?: string;
}): Promise<DevnetEvidenceReceipt> {
  if (input.manifest.network !== 'devnet') evidenceInput('devnet evidence requires a devnet release manifest');
  const report = parseDevnetE2eReport(input.report);
  const identity = releaseIdentity(input.manifest);
  if (!equalJson(report.releaseIdentity, identity)) evidenceInput('devnet E2E report release identity mismatch');
  const verification = await verifyRelease(input.manifest, input.build, input.rpc, input.localSbf);
  assertReleaseChecks(verification.checks, 'devnet release verification');
  await verifyDevnetTransactions(report, input.rpc);
  const verifiedAt = isoTimestamp(input.verifiedAt ?? new Date().toISOString(), 'devnet evidence.verifiedAt');
  if (Date.parse(verifiedAt) < Date.parse(report.completedAt)) evidenceInput('devnet evidence was verified before the E2E run completed');
  return {
    schemaVersion: 1,
    kind: 'devnet-e2e',
    generatedBy: 'scripts/escrow/cli.ts devnet-evidence',
    releaseManifest: input.manifest,
    releaseManifestSha256: identity.releaseManifestSha256,
    buildManifestSha256: identity.buildManifestSha256,
    reportSha256: asSha256(input.reportSha256, 'devnet evidence.reportSha256'),
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    verifiedAt,
    runId: report.runId,
    scenarios: report.scenarios,
    verificationChecks: verification.checks,
  };
}

export function parseDevnetEvidence(value: unknown): DevnetEvidenceReceipt {
  const root = asRecord(value, 'devnet evidence');
  rejectExtraKeys(root, [
    'schemaVersion',
    'kind',
    'generatedBy',
    'releaseManifest',
    'releaseManifestSha256',
    'buildManifestSha256',
    'reportSha256',
    'startedAt',
    'completedAt',
    'verifiedAt',
    'runId',
    'scenarios',
    'verificationChecks',
  ], 'devnet evidence');
  if (asInteger(root.schemaVersion, 'devnet evidence.schemaVersion') !== 1) evidenceInput('devnet evidence schemaVersion must be 1');
  if (asString(root.kind, 'devnet evidence.kind') !== 'devnet-e2e') evidenceInput('devnet evidence kind is invalid');
  if (asString(root.generatedBy, 'devnet evidence.generatedBy') !== 'scripts/escrow/cli.ts devnet-evidence') {
    evidenceInput('devnet evidence producer is invalid');
  }
  const releaseManifest = parseReleaseManifest(root.releaseManifest);
  if (releaseManifest.network !== 'devnet') evidenceInput('devnet evidence release manifest is not devnet');
  const identity = releaseIdentity(releaseManifest);
  if (asSha256(root.releaseManifestSha256, 'devnet evidence.releaseManifestSha256') !== identity.releaseManifestSha256) {
    evidenceInput('devnet evidence release manifest digest mismatch');
  }
  if (asSha256(root.buildManifestSha256, 'devnet evidence.buildManifestSha256') !== identity.buildManifestSha256) {
    evidenceInput('devnet evidence build manifest digest mismatch');
  }
  const report = parseDevnetE2eReport({
    schemaVersion: 1,
    kind: 'devnet-e2e-report',
    releaseIdentity: identity,
    startedAt: isoTimestamp(root.startedAt, 'devnet evidence.startedAt'),
    completedAt: isoTimestamp(root.completedAt, 'devnet evidence.completedAt'),
    runId: root.runId,
    scenarios: root.scenarios,
  });
  const verifiedAt = isoTimestamp(root.verifiedAt, 'devnet evidence.verifiedAt');
  if (Date.parse(verifiedAt) < Date.parse(report.completedAt)) evidenceInput('devnet evidence verification timestamp is invalid');
  const checks = stringArray(root.verificationChecks, 'devnet evidence.verificationChecks');
  assertReleaseChecks(checks, 'devnet evidence.verificationChecks');
  return {
    schemaVersion: 1,
    kind: 'devnet-e2e',
    generatedBy: 'scripts/escrow/cli.ts devnet-evidence',
    releaseManifest,
    releaseManifestSha256: identity.releaseManifestSha256,
    buildManifestSha256: identity.buildManifestSha256,
    reportSha256: asSha256(root.reportSha256, 'devnet evidence.reportSha256'),
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    verifiedAt,
    runId: report.runId,
    scenarios: report.scenarios,
    verificationChecks: checks,
  };
}

export function createLocalValidatorEvidence(input: {
  readonly releaseManifest: ReleaseManifest;
  readonly verificationChecks: readonly string[];
  readonly suiteSha256: string;
  readonly controlsSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly verifiedAt?: string;
}): LocalValidatorEvidenceReceipt {
  if (input.releaseManifest.network !== 'localnet') evidenceInput('local-validator evidence requires a localnet release manifest');
  const startedAt = isoTimestamp(input.startedAt, 'local-validator evidence.startedAt');
  const completedAt = isoTimestamp(input.completedAt, 'local-validator evidence.completedAt');
  assertTimeOrder(startedAt, completedAt, 'local-validator evidence');
  const verifiedAt = isoTimestamp(input.verifiedAt ?? completedAt, 'local-validator evidence.verifiedAt');
  if (Date.parse(verifiedAt) < Date.parse(completedAt)) evidenceInput('local-validator evidence verification predates completion');
  assertReleaseChecks(input.verificationChecks, 'local-validator evidence.verificationChecks');
  const identity = releaseIdentity(input.releaseManifest);
  return {
    schemaVersion: 1,
    kind: 'local-validator',
    generatedBy: 'scripts/escrow/cli.ts local-validator-evidence',
    runner: LOCAL_VALIDATOR_RUNNER,
    releaseManifest: input.releaseManifest,
    releaseManifestSha256: identity.releaseManifestSha256,
    buildManifestSha256: identity.buildManifestSha256,
    suiteSha256: asSha256(input.suiteSha256, 'local-validator evidence.suiteSha256'),
    controlsSha256: asSha256(input.controlsSha256, 'local-validator evidence.controlsSha256'),
    startedAt,
    completedAt,
    verifiedAt,
    verificationChecks: [...input.verificationChecks],
  };
}

export function parseLocalValidatorEvidence(value: unknown): LocalValidatorEvidenceReceipt {
  const root = asRecord(value, 'local-validator evidence');
  rejectExtraKeys(root, [
    'schemaVersion',
    'kind',
    'generatedBy',
    'runner',
    'releaseManifest',
    'releaseManifestSha256',
    'buildManifestSha256',
    'suiteSha256',
    'controlsSha256',
    'startedAt',
    'completedAt',
    'verifiedAt',
    'verificationChecks',
  ], 'local-validator evidence');
  if (asInteger(root.schemaVersion, 'local-validator evidence.schemaVersion') !== 1) evidenceInput('local-validator evidence schemaVersion must be 1');
  if (asString(root.kind, 'local-validator evidence.kind') !== 'local-validator') evidenceInput('local-validator evidence kind is invalid');
  if (asString(root.generatedBy, 'local-validator evidence.generatedBy') !== 'scripts/escrow/cli.ts local-validator-evidence') {
    evidenceInput('local-validator evidence producer is invalid');
  }
  if (asString(root.runner, 'local-validator evidence.runner') !== LOCAL_VALIDATOR_RUNNER) evidenceInput('local-validator runner identity mismatch');
  const releaseManifest = parseReleaseManifest(root.releaseManifest);
  const checks = stringArray(root.verificationChecks, 'local-validator evidence.verificationChecks');
  const receipt = createLocalValidatorEvidence({
    releaseManifest,
    verificationChecks: checks,
    suiteSha256: asSha256(root.suiteSha256, 'local-validator evidence.suiteSha256'),
    controlsSha256: asSha256(root.controlsSha256, 'local-validator evidence.controlsSha256'),
    startedAt: isoTimestamp(root.startedAt, 'local-validator evidence.startedAt'),
    completedAt: isoTimestamp(root.completedAt, 'local-validator evidence.completedAt'),
    verifiedAt: isoTimestamp(root.verifiedAt, 'local-validator evidence.verifiedAt'),
  });
  if (asSha256(root.releaseManifestSha256, 'local-validator evidence.releaseManifestSha256') !== receipt.releaseManifestSha256) {
    evidenceInput('local-validator release manifest digest mismatch');
  }
  if (asSha256(root.buildManifestSha256, 'local-validator evidence.buildManifestSha256') !== receipt.buildManifestSha256) {
    evidenceInput('local-validator build manifest digest mismatch');
  }
  return receipt;
}

export function evidenceSigningPayload(value: Record<string, unknown>): Buffer {
  return Buffer.from(`${SIGNING_DOMAIN}\0${stableJson(value)}`, 'utf8');
}

export function verifyEvidenceSignature(
  signedRecord: Record<string, unknown>,
  expectedPublicKey: string,
  label: string,
): void {
  const signerPublicKey = asPublicKey(signedRecord.signerPublicKey, `${label}.signerPublicKey`);
  if (signerPublicKey !== expectedPublicKey) evidenceInput(`${label} signer is not trusted for this evidence role`);
  const signatureText = asString(signedRecord.signature, `${label}.signature`);
  const signature = decodeBase58(signatureText);
  if (signature.length !== 64) evidenceInput(`${label}.signature must decode to 64 bytes`);
  const unsigned = { ...signedRecord };
  delete unsigned.signature;
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, decodeBase58(signerPublicKey)]),
    format: 'der',
    type: 'spki',
  });
  if (!verifySignature(null, evidenceSigningPayload(unsigned), publicKey, signature)) {
    evidenceInput(`${label} signature is invalid`);
  }
}
