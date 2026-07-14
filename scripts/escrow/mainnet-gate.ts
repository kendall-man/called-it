import { EscrowControlError, EXIT } from './types.js';
import {
  asAtomicString,
  asBoolean,
  asInteger,
  asPublicKey,
  asRecord,
  asSha256,
  asString,
  rejectExtraKeys,
} from './util.js';

const REQUIRED_AUTHORITY_ROLES = ['upgrade', 'config', 'pause', 'market_creation', 'feed_operator', 'oracle_set'] as const;
const MAX_CANARY_SOL_LAMPORTS = 50_000_000n;
const MAX_CANARY_USDC_MICROUNITS = 25_000_000n;
const MAX_CANARY_GROUPS = 10;

function blocked(message: string): never {
  throw new EscrowControlError(EXIT.gate, message);
}

function isoTimestamp(value: unknown, label: string): string {
  const text = asString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text) || Number.isNaN(Date.parse(text))) {
    blocked(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return text;
}

function passedArtifact(value: unknown, label: string, requiredFlags: readonly string[]): void {
  const record = asRecord(value, label);
  rejectExtraKeys(record, ['passed', 'artifactSha256', ...requiredFlags], label);
  if (!asBoolean(record.passed, `${label}.passed`)) blocked(`${label} did not pass`);
  asSha256(record.artifactSha256, `${label}.artifactSha256`);
  for (const flag of requiredFlags) {
    if (!asBoolean(record[flag], `${label}.${flag}`)) blocked(`${label}.${flag} is required`);
  }
}

export interface MainnetGateResult {
  readonly ok: true;
  readonly checks: readonly string[];
  readonly soakStart: string;
  readonly soakEnd: string;
}

export function verifyMainnetEvidence(value: unknown): MainnetGateResult {
  const root = asRecord(value, 'mainnet evidence');
  rejectExtraKeys(root, [
    'schemaVersion',
    'network',
    'releaseManifestSha256',
    'releaseVerificationArtifactSha256',
    'releaseVerifiedAt',
    'localValidator',
    'devnetE2e',
    'directClaimEngineDown',
    'pausedTimeoutVoid',
    'relayerRecovery',
    'legacyAudit',
    'soakSamples',
    'independentReview',
    'externalAudit',
    'authorities',
    'canary',
    'explicitApproval',
  ], 'mainnet evidence');
  if (asInteger(root.schemaVersion, 'mainnet evidence.schemaVersion') !== 1) blocked('evidence schemaVersion must be 1');
  if (asString(root.network, 'mainnet evidence.network') !== 'mainnet-beta') blocked('mainnet gate only accepts mainnet-beta evidence');
  asSha256(root.releaseManifestSha256, 'mainnet evidence.releaseManifestSha256');
  asSha256(root.releaseVerificationArtifactSha256, 'mainnet evidence.releaseVerificationArtifactSha256');
  isoTimestamp(root.releaseVerifiedAt, 'mainnet evidence.releaseVerifiedAt');

  passedArtifact(root.localValidator, 'localValidator', ['sol', 'usdc', 'adversarial']);
  passedArtifact(root.devnetE2e, 'devnetE2e', [
    'realSol',
    'realUsdc',
    'telegramPrivy',
    'settlement',
    'claim',
    'receipt',
    'retryRecovery',
  ]);
  passedArtifact(root.directClaimEngineDown, 'directClaimEngineDown', ['engineUnavailable', 'ownerDestinationOnly']);
  passedArtifact(root.pausedTimeoutVoid, 'pausedTimeoutVoid', ['protocolPaused', 'permissionlessRecovery']);
  passedArtifact(root.relayerRecovery, 'relayerRecovery', ['idempotent', 'noLostPositions', 'noDuplicatePositions']);
  const legacy = asRecord(root.legacyAudit, 'legacyAudit');
  rejectExtraKeys(legacy, [
    'passed',
    'artifactSha256',
    'withdrawalsAvailable',
    'noAutoMigration',
    'newCustodyIntakeDisabled',
    'liabilityDriftAtomic',
  ], 'legacyAudit');
  if (!asBoolean(legacy.passed, 'legacyAudit.passed')) blocked('legacy liability/withdrawal audit did not pass');
  asSha256(legacy.artifactSha256, 'legacyAudit.artifactSha256');
  for (const flag of ['withdrawalsAvailable', 'noAutoMigration', 'newCustodyIntakeDisabled'] as const) {
    if (!asBoolean(legacy[flag], `legacyAudit.${flag}`)) blocked(`legacyAudit.${flag} is required`);
  }
  if (asAtomicString(legacy.liabilityDriftAtomic, 'legacyAudit.liabilityDriftAtomic') !== '0') blocked('legacy liability drift must be zero');

  if (!Array.isArray(root.soakSamples) || root.soakSamples.length < 7) blocked('at least seven drift-clean soak samples are required');
  const samples = root.soakSamples.map((entry, index) => {
    const label = `soakSamples[${index}]`;
    const sample = asRecord(entry, label);
    rejectExtraKeys(sample, [
      'capturedAt',
      'driftAtomic',
      'signerAgreement',
      'relayerHealthy',
      'indexerHealthy',
      'rpcIdentityMatch',
      'artifactSha256',
    ], label);
    const capturedAt = isoTimestamp(sample.capturedAt, `${label}.capturedAt`);
    if (asAtomicString(sample.driftAtomic, `${label}.driftAtomic`) !== '0') blocked(`${label} has accounting drift`);
    for (const flag of ['signerAgreement', 'relayerHealthy', 'indexerHealthy', 'rpcIdentityMatch'] as const) {
      if (!asBoolean(sample[flag], `${label}.${flag}`)) blocked(`${label}.${flag} is false`);
    }
    asSha256(sample.artifactSha256, `${label}.artifactSha256`);
    return capturedAt;
  }).sort();
  const uniqueDays = new Set(samples.map((sample) => sample.slice(0, 10)));
  if (uniqueDays.size < 7) blocked('soak evidence must cover seven distinct UTC days');
  const orderedDays = [...uniqueDays].sort();
  for (let index = 1; index < orderedDays.length; index += 1) {
    const previous = Date.parse(`${orderedDays[index - 1]}T00:00:00Z`);
    const current = Date.parse(`${orderedDays[index]}T00:00:00Z`);
    if (current - previous !== 86_400_000) blocked('soak samples must be captured on consecutive UTC days');
  }
  const firstDay = Date.parse(`${orderedDays[0]}T00:00:00Z`);
  const lastDay = Date.parse(`${orderedDays.at(-1)}T00:00:00Z`);
  if ((lastDay - firstDay) / 86_400_000 + 1 < 7) blocked('soak evidence must span at least seven calendar days');

  const review = asRecord(root.independentReview, 'independentReview');
  rejectExtraKeys(review, ['passed', 'artifactSha256', 'criticalOpen', 'highOpen'], 'independentReview');
  if (!asBoolean(review.passed, 'independentReview.passed')) blocked('independent review is not closed');
  asSha256(review.artifactSha256, 'independentReview.artifactSha256');
  if (asInteger(review.criticalOpen, 'independentReview.criticalOpen') !== 0 || asInteger(review.highOpen, 'independentReview.highOpen') !== 0) {
    blocked('independent review has open critical/high findings');
  }
  const audit = asRecord(root.externalAudit, 'externalAudit');
  rejectExtraKeys(audit, ['passed', 'artifactSha256', 'criticalOpen', 'highOpen'], 'externalAudit');
  if (!asBoolean(audit.passed, 'externalAudit.passed')) blocked('external audit is not closed');
  asSha256(audit.artifactSha256, 'externalAudit.artifactSha256');
  if (asInteger(audit.criticalOpen, 'externalAudit.criticalOpen') !== 0 || asInteger(audit.highOpen, 'externalAudit.highOpen') !== 0) {
    blocked('external audit has open critical/high findings');
  }

  if (!Array.isArray(root.authorities)) blocked('authorities must be an array');
  const roles = new Set<string>();
  for (const [index, entry] of root.authorities.entries()) {
    const label = `authorities[${index}]`;
    const authority = asRecord(entry, label);
    rejectExtraKeys(authority, ['role', 'address', 'multisig', 'threshold', 'signerCount'], label);
    const role = asString(authority.role, `${label}.role`);
    if (roles.has(role)) blocked(`duplicate authority role ${role}`);
    roles.add(role);
    asPublicKey(authority.address, `${label}.address`);
    if (!asBoolean(authority.multisig, `${label}.multisig`)) blocked(`${role} authority is not multisig-controlled`);
    const threshold = asInteger(authority.threshold, `${label}.threshold`);
    const signerCount = asInteger(authority.signerCount, `${label}.signerCount`);
    if (threshold < 2 || signerCount < threshold) blocked(`${role} multisig threshold is invalid`);
    if (role === 'oracle_set' && (threshold !== 2 || signerCount !== 3)) blocked('oracle set must be exactly 2-of-3');
  }
  for (const role of REQUIRED_AUTHORITY_ROLES) if (!roles.has(role)) blocked(`missing multisig authority evidence for ${role}`);

  const canary = asRecord(root.canary, 'canary');
  rejectExtraKeys(canary, ['allowlistEnabled', 'groupCount', 'minSolPosition', 'maxSolPosition', 'minUsdcPosition', 'maxUsdcPosition'], 'canary');
  if (!asBoolean(canary.allowlistEnabled, 'canary.allowlistEnabled')) blocked('mainnet canary allowlist is disabled');
  const groupCount = asInteger(canary.groupCount, 'canary.groupCount');
  if (groupCount < 1 || groupCount > MAX_CANARY_GROUPS) blocked(`mainnet canary group count must be 1-${MAX_CANARY_GROUPS}`);
  const minSol = BigInt(asAtomicString(canary.minSolPosition, 'canary.minSolPosition'));
  const maxSol = BigInt(asAtomicString(canary.maxSolPosition, 'canary.maxSolPosition'));
  const minUsdc = BigInt(asAtomicString(canary.minUsdcPosition, 'canary.minUsdcPosition'));
  const maxUsdc = BigInt(asAtomicString(canary.maxUsdcPosition, 'canary.maxUsdcPosition'));
  if (minSol <= 0n || minSol > maxSol || maxSol > MAX_CANARY_SOL_LAMPORTS) blocked('mainnet SOL canary caps are not low and bounded');
  if (minUsdc <= 0n || minUsdc > maxUsdc || maxUsdc > MAX_CANARY_USDC_MICROUNITS) blocked('mainnet USDC canary caps are not low and bounded');

  const approval = asRecord(root.explicitApproval, 'explicitApproval');
  rejectExtraKeys(approval, ['approved', 'approvedAt', 'artifactSha256', 'scope'], 'explicitApproval');
  if (!asBoolean(approval.approved, 'explicitApproval.approved')) blocked('explicit mainnet value-enablement approval is absent');
  isoTimestamp(approval.approvedAt, 'explicitApproval.approvedAt');
  asSha256(approval.artifactSha256, 'explicitApproval.artifactSha256');
  if (asString(approval.scope, 'explicitApproval.scope') !== 'mainnet escrow canary value enablement') {
    blocked('explicit approval scope is not the mainnet escrow canary');
  }

  return {
    ok: true,
    checks: [
      'release identity evidence',
      'local validator SOL/USDC adversarial suite',
      'real devnet SOL/USDC Telegram/Privy E2E',
      'engine-down direct claim',
      'paused permissionless timeout void',
      'relayer recovery and idempotency',
      'legacy withdrawal/liability isolation',
      'seven-day drift-clean soak',
      'independent review and external audit',
      'multisig authority control',
      'low capped allowlisted canary',
      'explicit mainnet approval',
    ],
    soakStart: samples[0]!,
    soakEnd: samples.at(-1)!,
  };
}
