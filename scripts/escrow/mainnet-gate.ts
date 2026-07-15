import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  buildManifestDigest,
  createDevnetEvidence,
  isoTimestamp,
  parseDevnetE2eReport,
  parseDevnetEvidence,
  parseLocalValidatorEvidence,
  parseReleaseIdentity,
  releaseIdentity,
  verifyEvidenceSignature,
  type ReleaseIdentity,
} from './evidence.js';
import { verifyIdlPolicy } from './idl-policy.js';
import { buildProvenance, parseReleaseManifest } from './manifest.js';
import { formatOpsStatus } from './ops-status.js';
import { verifyRelease } from './release.js';
import type { BuildManifest, EvidenceRpcReader, ReleaseManifest, RpcReader } from './types.js';
import { EscrowControlError, EXIT } from './types.js';
import {
  asAtomicString,
  asBoolean,
  asInteger,
  asPublicKey,
  asRecord,
  asSha256,
  asString,
  equalJson,
  rejectExtraKeys,
  sha256,
  sha256Tree,
  stableJson,
} from './util.js';

const REQUIRED_AUTHORITY_ROLES = ['upgrade', 'config', 'pause', 'market_creation', 'feed_operator', 'oracle_set'] as const;
const MAX_CANARY_SOL_LAMPORTS = 50_000_000n;
const MAX_CANARY_USDC_MICROUNITS = 25_000_000n;
const MAX_CANARY_GROUPS = 10;
const MAX_MACHINE_EVIDENCE_AGE_MS = 72 * 60 * 60 * 1_000;
const MAX_SOAK_AGE_MS = 36 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

const ARTIFACT_KEYS = [
  'releaseManifest',
  'localValidator',
  'devnetEvidence',
  'devnetReport',
  'devnetProgramSo',
  'devnetIdl',
  'legacyAuditStatement',
  'legacyAuditReport',
  'independentReviewStatement',
  'independentReviewReport',
  'externalAuditStatement',
  'externalAuditReport',
  'authorityStatement',
  'authorityReport',
  'soakSamples',
  'approvalStatement',
] as const;

interface ArtifactReference {
  readonly path: string;
  readonly sha256: string;
}

interface TrustedEvidenceSigners {
  readonly operations: string;
  readonly independentReview: string;
  readonly externalAudit: string;
  readonly authority: string;
  readonly approval: string;
}

export interface MainnetGateContext {
  readonly manifest: ReleaseManifest;
  readonly localBuild: BuildManifest;
  readonly mainnetRpc: RpcReader;
  readonly mainnetSbf: Uint8Array;
  readonly mainnetIdl: unknown;
  readonly devnetRpc: EvidenceRpcReader;
  readonly sourcePath: string;
  readonly lockPath: string;
  readonly artifactRoot: string;
  readonly integrationSuitePath: string;
  readonly controlsPath: string;
  readonly trustedSigners: TrustedEvidenceSigners;
  readonly now?: Date;
}

export interface MainnetGateResult {
  readonly ok: true;
  readonly checks: readonly string[];
  readonly releaseVerifiedAt: string;
  readonly soakStart: string;
  readonly soakEnd: string;
}

function blocked(message: string): never {
  throw new EscrowControlError(EXIT.gate, message);
}

function artifactReference(value: unknown, label: string): ArtifactReference {
  const record = asRecord(value, label);
  rejectExtraKeys(record, ['path', 'sha256'], label);
  const path = asString(record.path, `${label}.path`);
  if (isAbsolute(path) || path.split(/[\\/]/u).some((part) => part === '' || part === '.' || part === '..')) {
    blocked(`${label}.path must be a normalized relative path`);
  }
  return { path, sha256: asSha256(record.sha256, `${label}.sha256`) };
}

class ArtifactStore {
  private readonly cache = new Map<string, Buffer>();
  private rootRealPath: string | undefined;

  constructor(private readonly root: string) {}

  async bytes(reference: ArtifactReference, label: string): Promise<Buffer> {
    const cached = this.cache.get(reference.path);
    if (cached !== undefined) {
      if (sha256(cached) !== reference.sha256) blocked(`${label} conflicts with an earlier artifact digest`);
      return cached;
    }
    const rootRealPath = this.rootRealPath ?? await realpath(this.root).catch(() => blocked(`artifact root is missing: ${this.root}`));
    this.rootRealPath = rootRealPath;
    const candidate = resolve(rootRealPath, reference.path);
    const metadata = await lstat(candidate).catch(() => blocked(`${label} artifact is missing: ${reference.path}`));
    if (!metadata.isFile() || metadata.isSymbolicLink()) blocked(`${label} artifact must be a regular non-symlink file`);
    const candidateRealPath = await realpath(candidate).catch(() => blocked(`${label} artifact cannot be resolved`));
    const relativePath = relative(rootRealPath, candidateRealPath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) blocked(`${label} artifact escapes the evidence root`);
    const bytes = await readFile(candidateRealPath).catch(() => blocked(`${label} artifact cannot be read`));
    if (sha256(bytes) !== reference.sha256) blocked(`${label} artifact SHA-256 mismatch`);
    this.cache.set(reference.path, bytes);
    return bytes;
  }

  async json(reference: ArtifactReference, label: string): Promise<unknown> {
    const bytes = await this.bytes(reference, label);
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      blocked(`${label} artifact is not valid JSON`);
    }
  }
}

function assertExact(actual: unknown, expected: unknown, label: string): void {
  if (!equalJson(actual, expected)) blocked(`${label} mismatch`);
}

function signedStatement(
  value: unknown,
  label: string,
  kind: string,
  keys: readonly string[],
  trustedSigner: string,
): Record<string, unknown> {
  const record = asRecord(value, label);
  rejectExtraKeys(record, ['schemaVersion', 'kind', ...keys, 'signerPublicKey', 'signature'], label);
  if (asInteger(record.schemaVersion, `${label}.schemaVersion`) !== 1) blocked(`${label}.schemaVersion must be 1`);
  if (asString(record.kind, `${label}.kind`) !== kind) blocked(`${label}.kind must be ${kind}`);
  verifyEvidenceSignature(record, trustedSigner, label);
  return record;
}

function statementIdentity(record: Record<string, unknown>, expected: ReleaseIdentity, label: string): void {
  assertExact(parseReleaseIdentity(record.releaseIdentity, `${label}.releaseIdentity`), expected, `${label} release identity`);
}

function verifyReviewStatement(input: {
  readonly value: unknown;
  readonly label: string;
  readonly kind: 'independent-review' | 'external-audit';
  readonly trustedSigner: string;
  readonly reportSha256: string;
  readonly identity: ReleaseIdentity;
}): { readonly closedAt: string } {
  const record = signedStatement(input.value, input.label, input.kind, [
    'releaseIdentity',
    'reportSha256',
    'issuer',
    'reportId',
    'scope',
    'issuedAt',
    'closedAt',
    'criticalOpen',
    'highOpen',
  ], input.trustedSigner);
  statementIdentity(record, input.identity, input.label);
  if (asSha256(record.reportSha256, `${input.label}.reportSha256`) !== input.reportSha256) blocked(`${input.label} report digest mismatch`);
  asString(record.issuer, `${input.label}.issuer`);
  asString(record.reportId, `${input.label}.reportId`);
  if (asString(record.scope, `${input.label}.scope`) !== 'calledit escrow mainnet program and release') blocked(`${input.label} scope is incomplete`);
  const issuedAt = isoTimestamp(record.issuedAt, `${input.label}.issuedAt`);
  const closedAt = isoTimestamp(record.closedAt, `${input.label}.closedAt`);
  if (Date.parse(issuedAt) > Date.parse(closedAt)) blocked(`${input.label} closes before issuance`);
  if (asInteger(record.criticalOpen, `${input.label}.criticalOpen`) !== 0 || asInteger(record.highOpen, `${input.label}.highOpen`) !== 0) {
    blocked(`${input.label} has open critical/high findings`);
  }
  return { closedAt };
}

function authorityExpectations(manifest: ReleaseManifest): Readonly<Record<string, string>> {
  return {
    upgrade: manifest.upgradeAuthority,
    config: manifest.config.configAuthority,
    pause: manifest.config.pauseAuthority,
    market_creation: manifest.config.marketCreationAuthority,
    feed_operator: manifest.config.feedOperatorAuthority,
    oracle_set: manifest.oracleSet.address,
  };
}

function verifyAuthorityStatement(input: {
  readonly value: unknown;
  readonly trustedSigner: string;
  readonly reportSha256: string;
  readonly identity: ReleaseIdentity;
  readonly manifest: ReleaseManifest;
}): { readonly verifiedAt: string } {
  const label = 'authority provenance';
  const record = signedStatement(input.value, label, 'authority-provenance', [
    'releaseIdentity',
    'reportSha256',
    'verifier',
    'recordId',
    'verifiedAt',
    'roles',
  ], input.trustedSigner);
  statementIdentity(record, input.identity, label);
  if (asSha256(record.reportSha256, `${label}.reportSha256`) !== input.reportSha256) blocked(`${label} report digest mismatch`);
  asString(record.verifier, `${label}.verifier`);
  asString(record.recordId, `${label}.recordId`);
  const verifiedAt = isoTimestamp(record.verifiedAt, `${label}.verifiedAt`);
  if (!Array.isArray(record.roles)) blocked(`${label}.roles must be an array`);
  const expected = authorityExpectations(input.manifest);
  const found = new Set<string>();
  for (const [index, value] of record.roles.entries()) {
    const roleLabel = `${label}.roles[${index}]`;
    const roleRecord = asRecord(value, roleLabel);
    rejectExtraKeys(roleRecord, ['role', 'address', 'threshold', 'members'], roleLabel);
    const role = asString(roleRecord.role, `${roleLabel}.role`);
    if (!REQUIRED_AUTHORITY_ROLES.includes(role as (typeof REQUIRED_AUTHORITY_ROLES)[number])) blocked(`${roleLabel}.role is unsupported`);
    if (found.has(role)) blocked(`duplicate authority role ${role}`);
    found.add(role);
    const address = asPublicKey(roleRecord.address, `${roleLabel}.address`);
    if (address !== expected[role]) blocked(`${role} authority does not match the verified release manifest`);
    const threshold = asInteger(roleRecord.threshold, `${roleLabel}.threshold`);
    if (!Array.isArray(roleRecord.members)) blocked(`${roleLabel}.members must be an array`);
    const members = roleRecord.members.map((member, memberIndex) => asPublicKey(member, `${roleLabel}.members[${memberIndex}]`));
    if (new Set(members).size !== members.length || threshold < 2 || members.length < threshold) blocked(`${role} multisig membership/threshold is invalid`);
    if (role === 'oracle_set') {
      if (threshold !== 2 || !equalJson(members, input.manifest.oracleSet.signers)) blocked('oracle set authority evidence must match the verified 2-of-3 signer set');
    }
  }
  for (const role of REQUIRED_AUTHORITY_ROLES) if (!found.has(role)) blocked(`missing authority provenance for ${role}`);
  return { verifiedAt };
}

function verifyLegacyStatement(input: {
  readonly value: unknown;
  readonly trustedSigner: string;
  readonly reportSha256: string;
  readonly identity: ReleaseIdentity;
}): { readonly closedAt: string } {
  const label = 'legacy audit';
  const record = signedStatement(input.value, label, 'legacy-audit', [
    'releaseIdentity',
    'reportSha256',
    'auditor',
    'auditId',
    'issuedAt',
    'closedAt',
    'withdrawalsAvailable',
    'noAutoMigration',
    'newCustodyIntakeDisabled',
    'liabilityDriftAtomic',
  ], input.trustedSigner);
  statementIdentity(record, input.identity, label);
  if (asSha256(record.reportSha256, `${label}.reportSha256`) !== input.reportSha256) blocked(`${label} report digest mismatch`);
  asString(record.auditor, `${label}.auditor`);
  asString(record.auditId, `${label}.auditId`);
  const issuedAt = isoTimestamp(record.issuedAt, `${label}.issuedAt`);
  const closedAt = isoTimestamp(record.closedAt, `${label}.closedAt`);
  if (Date.parse(issuedAt) > Date.parse(closedAt)) blocked(`${label} closes before issuance`);
  for (const field of ['withdrawalsAvailable', 'noAutoMigration', 'newCustodyIntakeDisabled'] as const) {
    if (!asBoolean(record[field], `${label}.${field}`)) blocked(`${label}.${field} is required`);
  }
  if (asAtomicString(record.liabilityDriftAtomic, `${label}.liabilityDriftAtomic`) !== '0') blocked('legacy liability drift must be zero');
  return { closedAt };
}

function verifyCanary(value: unknown, manifest: ReleaseManifest): void {
  const canary = asRecord(value, 'canary');
  rejectExtraKeys(canary, ['allowlistEnabled', 'groupCount', 'minSolPosition', 'maxSolPosition', 'minUsdcPosition', 'maxUsdcPosition'], 'canary');
  if (!asBoolean(canary.allowlistEnabled, 'canary.allowlistEnabled')) blocked('mainnet canary allowlist is disabled');
  const groupCount = asInteger(canary.groupCount, 'canary.groupCount');
  if (groupCount < 1 || groupCount > MAX_CANARY_GROUPS) blocked(`mainnet canary group count must be 1-${MAX_CANARY_GROUPS}`);
  const expected = manifest.config;
  for (const field of ['minSolPosition', 'maxSolPosition', 'minUsdcPosition', 'maxUsdcPosition'] as const) {
    if (asAtomicString(canary[field], `canary.${field}`) !== expected[field]) blocked(`canary.${field} does not match the verified on-chain config`);
  }
  const minSol = BigInt(expected.minSolPosition);
  const maxSol = BigInt(expected.maxSolPosition);
  const minUsdc = BigInt(expected.minUsdcPosition);
  const maxUsdc = BigInt(expected.maxUsdcPosition);
  if (minSol <= 0n || minSol > maxSol || maxSol > MAX_CANARY_SOL_LAMPORTS) blocked('mainnet SOL canary caps are not low and bounded');
  if (minUsdc <= 0n || minUsdc > maxUsdc || maxUsdc > MAX_CANARY_USDC_MICROUNITS) blocked('mainnet USDC canary caps are not low and bounded');
}

export function approvalBundleDigest(value: unknown): string {
  const root = structuredClone(asRecord(value, 'mainnet evidence'));
  const artifacts = asRecord(root.artifacts, 'mainnet evidence.artifacts');
  delete artifacts.approvalStatement;
  return sha256(stableJson(root));
}

function verifyApproval(input: {
  readonly value: unknown;
  readonly trustedSigner: string;
  readonly identity: ReleaseIdentity;
  readonly bundleSha256: string;
}): { readonly approvedAt: string } {
  const label = 'explicit approval';
  const record = signedStatement(input.value, label, 'mainnet-approval', [
    'releaseIdentity',
    'bundleSha256',
    'scope',
    'approver',
    'approvalId',
    'approvedAt',
  ], input.trustedSigner);
  statementIdentity(record, input.identity, label);
  if (asSha256(record.bundleSha256, `${label}.bundleSha256`) !== input.bundleSha256) blocked('explicit approval is not bound to this evidence bundle');
  if (asString(record.scope, `${label}.scope`) !== 'mainnet escrow canary value enablement') blocked('explicit approval scope is not the mainnet escrow canary');
  asString(record.approver, `${label}.approver`);
  asString(record.approvalId, `${label}.approvalId`);
  return { approvedAt: isoTimestamp(record.approvedAt, `${label}.approvedAt`) };
}

function assertNotStale(timestamp: string, approvedAt: string, maxAge: number, label: string): void {
  const age = Date.parse(approvedAt) - Date.parse(timestamp);
  if (age < 0) blocked(`${label} was produced after approval`);
  if (age > maxAge) blocked(`${label} is stale for this approval`);
}

function parseJsonBytes(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    blocked(`${label} is not valid JSON`);
  }
}

export async function verifyMainnetEvidence(
  value: unknown,
  context: MainnetGateContext,
): Promise<MainnetGateResult> {
  const root = asRecord(value, 'mainnet evidence');
  if (asInteger(root.schemaVersion, 'mainnet evidence.schemaVersion') !== 2) blocked('mainnet evidence schemaVersion must be 2; legacy flag-only evidence is forbidden');
  rejectExtraKeys(root, ['schemaVersion', 'network', 'releaseIdentity', 'artifacts', 'canary'], 'mainnet evidence');
  if (asString(root.network, 'mainnet evidence.network') !== 'mainnet-beta') blocked('mainnet gate only accepts mainnet-beta evidence');
  if (context.manifest.network !== 'mainnet-beta') blocked('live release manifest is not mainnet-beta');

  const now = context.now ?? new Date();
  if (Number.isNaN(now.getTime())) blocked('verification clock is invalid');
  const expectedIdentity = releaseIdentity(context.manifest);
  assertExact(parseReleaseIdentity(root.releaseIdentity, 'mainnet evidence.releaseIdentity'), expectedIdentity, 'mainnet release identity');
  if (buildManifestDigest(context.localBuild) !== expectedIdentity.buildManifestSha256) blocked('recomputed mainnet build manifest digest mismatch');

  const artifacts = asRecord(root.artifacts, 'mainnet evidence.artifacts');
  rejectExtraKeys(artifacts, ARTIFACT_KEYS, 'mainnet evidence.artifacts');
  const scalarReferences = Object.fromEntries(ARTIFACT_KEYS
    .filter((key) => key !== 'soakSamples')
    .map((key) => [key, artifactReference(artifacts[key], `mainnet evidence.artifacts.${key}`)])) as Record<string, ArtifactReference>;
  if (!Array.isArray(artifacts.soakSamples) || artifacts.soakSamples.length < 7) blocked('at least seven soak sample artifacts are required');
  const soakEntries = artifacts.soakSamples.map((value, index) => {
    const label = `mainnet evidence.artifacts.soakSamples[${index}]`;
    const record = asRecord(value, label);
    rejectExtraKeys(record, ['capturedAt', 'clusterGenesisHash', 'programId', 'releaseManifestSha256', 'artifact'], label);
    return {
      capturedAt: isoTimestamp(record.capturedAt, `${label}.capturedAt`),
      clusterGenesisHash: asPublicKey(record.clusterGenesisHash, `${label}.clusterGenesisHash`),
      programId: asPublicKey(record.programId, `${label}.programId`),
      releaseManifestSha256: asSha256(record.releaseManifestSha256, `${label}.releaseManifestSha256`),
      artifact: artifactReference(record.artifact, `${label}.artifact`),
    };
  });
  const allPaths = [...Object.values(scalarReferences), ...soakEntries.map((entry) => entry.artifact)].map((reference) => reference.path);
  if (new Set(allPaths).size !== allPaths.length) blocked('each evidence role must use a distinct artifact path');

  const store = new ArtifactStore(context.artifactRoot);
  const releaseManifestValue = await store.json(scalarReferences.releaseManifest!, 'release manifest');
  assertExact(parseReleaseManifest(releaseManifestValue), context.manifest, 'release manifest artifact');
  verifyIdlPolicy(context.mainnetIdl);
  const mainnetVerification = await verifyRelease(context.manifest, context.localBuild, context.mainnetRpc, context.mainnetSbf);

  const localReceipt = parseLocalValidatorEvidence(await store.json(scalarReferences.localValidator!, 'local-validator evidence'));
  if (localReceipt.releaseManifest.build.sourceCommit !== expectedIdentity.sourceCommit) blocked('local-validator evidence source commit differs from mainnet');
  if (localReceipt.releaseManifest.build.sourceSha256 !== expectedIdentity.sourceSha256) blocked('local-validator evidence source tree differs from mainnet');
  if (localReceipt.releaseManifest.build.lockSha256 !== expectedIdentity.lockSha256) blocked('local-validator evidence lockfile differs from mainnet');
  if (localReceipt.suiteSha256 !== await sha256Tree(context.integrationSuitePath)) blocked('local-validator suite digest is not current');
  if (localReceipt.controlsSha256 !== await sha256Tree(context.controlsPath)) blocked('local-validator control implementation digest is not current');

  const devnetReceipt = parseDevnetEvidence(await store.json(scalarReferences.devnetEvidence!, 'devnet evidence'));
  const devnetReportBytes = await store.bytes(scalarReferences.devnetReport!, 'devnet E2E report');
  if (devnetReceipt.reportSha256 !== scalarReferences.devnetReport!.sha256) blocked('devnet evidence does not bind the supplied E2E report');
  const devnetReport = parseDevnetE2eReport(parseJsonBytes(devnetReportBytes, 'devnet E2E report'));
  assertExact(devnetReport.releaseIdentity, releaseIdentity(devnetReceipt.releaseManifest), 'devnet report release identity');
  if (devnetReceipt.releaseManifest.build.sourceCommit !== expectedIdentity.sourceCommit) blocked('devnet evidence source commit differs from mainnet');
  if (devnetReceipt.releaseManifest.build.sourceSha256 !== expectedIdentity.sourceSha256) blocked('devnet evidence source tree differs from mainnet');
  if (devnetReceipt.releaseManifest.build.lockSha256 !== expectedIdentity.lockSha256) blocked('devnet evidence lockfile differs from mainnet');
  const devnetProgramSo = await store.bytes(scalarReferences.devnetProgramSo!, 'devnet SBF');
  const devnetIdlBytes = await store.bytes(scalarReferences.devnetIdl!, 'devnet IDL');
  const devnetIdl = parseJsonBytes(devnetIdlBytes, 'devnet IDL');
  verifyIdlPolicy(devnetIdl);
  const devnetBuild = await buildProvenance(expectedIdentity.sourceCommit, {
    programSo: resolve(context.artifactRoot, scalarReferences.devnetProgramSo!.path),
    idl: resolve(context.artifactRoot, scalarReferences.devnetIdl!.path),
    source: context.sourcePath,
    lock: context.lockPath,
  });
  assertExact(devnetBuild, devnetReceipt.releaseManifest.build, 'recomputed devnet build');
  await createDevnetEvidence({
    manifest: devnetReceipt.releaseManifest,
    build: devnetBuild,
    rpc: context.devnetRpc,
    localSbf: devnetProgramSo,
    report: devnetReport,
    reportSha256: scalarReferences.devnetReport!.sha256,
    verifiedAt: now.toISOString(),
  });

  const legacyReport = scalarReferences.legacyAuditReport!;
  await store.bytes(legacyReport, 'legacy audit report');
  const legacy = verifyLegacyStatement({
    value: await store.json(scalarReferences.legacyAuditStatement!, 'legacy audit statement'),
    trustedSigner: context.trustedSigners.operations,
    reportSha256: legacyReport.sha256,
    identity: expectedIdentity,
  });
  const reviewReport = scalarReferences.independentReviewReport!;
  await store.bytes(reviewReport, 'independent review report');
  const review = verifyReviewStatement({
    value: await store.json(scalarReferences.independentReviewStatement!, 'independent review statement'),
    label: 'independent review',
    kind: 'independent-review',
    trustedSigner: context.trustedSigners.independentReview,
    reportSha256: reviewReport.sha256,
    identity: expectedIdentity,
  });
  const auditReport = scalarReferences.externalAuditReport!;
  await store.bytes(auditReport, 'external audit report');
  const audit = verifyReviewStatement({
    value: await store.json(scalarReferences.externalAuditStatement!, 'external audit statement'),
    label: 'external audit',
    kind: 'external-audit',
    trustedSigner: context.trustedSigners.externalAudit,
    reportSha256: auditReport.sha256,
    identity: expectedIdentity,
  });
  const authorityReport = scalarReferences.authorityReport!;
  await store.bytes(authorityReport, 'authority report');
  const authority = verifyAuthorityStatement({
    value: await store.json(scalarReferences.authorityStatement!, 'authority statement'),
    trustedSigner: context.trustedSigners.authority,
    reportSha256: authorityReport.sha256,
    identity: expectedIdentity,
    manifest: context.manifest,
  });

  const devnetIdentity = releaseIdentity(devnetReceipt.releaseManifest);
  const sampleTimes: string[] = [];
  for (const [index, entry] of soakEntries.entries()) {
    if (entry.clusterGenesisHash !== devnetIdentity.clusterGenesisHash || entry.programId !== devnetIdentity.programId || entry.releaseManifestSha256 !== devnetIdentity.releaseManifestSha256) {
      blocked(`soak sample ${index} devnet identity mismatch`);
    }
    const sampleValue = await store.json(entry.artifact, `soak sample ${index}`);
    const sampleRecord = asRecord(sampleValue, `soak sample ${index}`);
    if (asString(sampleRecord.cluster, `soak sample ${index}.cluster`) !== 'devnet') blocked(`soak sample ${index} is not devnet`);
    const capturedAt = isoTimestamp(sampleRecord.capturedAt, `soak sample ${index}.capturedAt`);
    if (capturedAt !== entry.capturedAt) blocked(`soak sample ${index} capturedAt mismatch`);
    if (!formatOpsStatus(sampleValue).healthy) blocked(`soak sample ${index} is unhealthy`);
    sampleTimes.push(capturedAt);
  }
  sampleTimes.sort();
  const days = sampleTimes.map((sample) => sample.slice(0, 10));
  if (new Set(days).size !== days.length) blocked('soak evidence must use distinct UTC days');
  for (let index = 1; index < days.length; index += 1) {
    const previous = Date.parse(`${days[index - 1]}T00:00:00Z`);
    const current = Date.parse(`${days[index]}T00:00:00Z`);
    if (current - previous !== 86_400_000) blocked('soak samples must be captured on consecutive UTC days');
  }

  verifyCanary(root.canary, context.manifest);
  const approval = verifyApproval({
    value: await store.json(scalarReferences.approvalStatement!, 'explicit approval statement'),
    trustedSigner: context.trustedSigners.approval,
    identity: expectedIdentity,
    bundleSha256: approvalBundleDigest(root),
  });
  if (Date.parse(approval.approvedAt) > now.getTime() + CLOCK_SKEW_MS) blocked('explicit approval timestamp is in the future');
  assertNotStale(localReceipt.verifiedAt, approval.approvedAt, MAX_MACHINE_EVIDENCE_AGE_MS, 'local-validator evidence');
  assertNotStale(devnetReceipt.verifiedAt, approval.approvedAt, MAX_MACHINE_EVIDENCE_AGE_MS, 'devnet E2E evidence');
  assertNotStale(sampleTimes.at(-1)!, approval.approvedAt, MAX_SOAK_AGE_MS, 'latest soak sample');
  for (const [label, timestamp] of [
    ['legacy audit', legacy.closedAt],
    ['independent review', review.closedAt],
    ['external audit', audit.closedAt],
    ['authority provenance', authority.verifiedAt],
  ] as const) {
    if (Date.parse(timestamp) > Date.parse(approval.approvedAt)) blocked(`${label} was completed after explicit approval`);
  }

  return {
    ok: true,
    checks: [
      ...mainnetVerification.checks,
      'current IDL policy',
      'generated local-validator release evidence',
      'live devnet release and finalized E2E transactions',
      'artifact-bound drift-clean soak',
      'signed legacy, review, audit, and authority provenance',
      'on-chain canary caps',
      'signed bundle-specific mainnet approval',
    ],
    releaseVerifiedAt: now.toISOString(),
    soakStart: sampleTimes[0]!,
    soakEnd: sampleTimes.at(-1)!,
  };
}
