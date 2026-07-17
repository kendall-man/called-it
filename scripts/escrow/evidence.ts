import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

import { parseReleaseManifest } from './manifest.js';
import {
  parsePayoutDifferentialEvidenceReceipt,
  type PayoutDifferentialEvidenceReceipt,
} from './payout-differential-evidence.js';
import { findProgramAddress, manifestDigest, verifyRelease } from './release.js';
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
const PLACE_POSITION_DATA_LENGTH = 126;

type VerifiedInstructionKind =
  | 'place_position'
  | 'calculate_position_entitlement'
  | 'timeout_void'
  | 'claim_position'
  | 'claim_position_for';

interface FinalizedInstruction {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly data: Buffer;
}

interface TokenBalance {
  readonly account: string;
  readonly mint: string;
  readonly amount: bigint;
}

interface DecodedFinalizedTransaction {
  readonly accountKeys: readonly string[];
  readonly instructions: readonly FinalizedInstruction[];
  readonly preBalances: readonly bigint[];
  readonly postBalances: readonly bigint[];
  readonly preTokenBalances: readonly TokenBalance[];
  readonly postTokenBalances: readonly TokenBalance[];
}

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
  readonly payoutDifferential: PayoutDifferentialEvidenceReceipt;
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

function instructionDiscriminator(kind: VerifiedInstructionKind): Buffer {
  return createHash('sha256').update(`global:${kind}`).digest().subarray(0, 8);
}

function deterministicMarket(runId: string, scenario: DevnetScenario['id'], programId: string): {
  readonly uuidBytes: Buffer;
  readonly address: string;
} {
  const uuidBytes = createHash('sha256')
    .update('calledit.devnet-e2e.market.v1')
    .update(runId)
    .update(scenario)
    .digest()
    .subarray(0, 16);
  uuidBytes[6] = (uuidBytes[6] ?? 0) & 0x0f | 0x40;
  uuidBytes[8] = (uuidBytes[8] ?? 0) & 0x3f | 0x80;
  return {
    uuidBytes,
    address: findProgramAddress([Buffer.from('market'), uuidBytes], programId).address,
  };
}

function publicKeyArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) evidenceInput(`${label} must be an array`);
  return value.map((entry, index) => asPublicKey(entry, `${label}[${index}]`));
}

function balanceArray(value: unknown, label: string, expectedLength: number): readonly bigint[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    evidenceInput(`${label} must align exactly with transaction account keys`);
  }
  return value.map((entry, index) => {
    const amount = asInteger(entry, `${label}[${index}]`);
    if (amount < 0) evidenceInput(`${label}[${index}] must be non-negative`);
    return BigInt(amount);
  });
}

function tokenBalances(value: unknown, label: string): readonly TokenBalance[] {
  if (!Array.isArray(value)) evidenceInput(`${label} must be an array`);
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const record = asRecord(entry, itemLabel);
    rejectExtraKeys(record, ['account', 'mint', 'amount'], itemLabel);
    const amount = asString(record.amount, `${itemLabel}.amount`);
    if (!/^(0|[1-9][0-9]*)$/.test(amount)) evidenceInput(`${itemLabel}.amount must be an atomic decimal string`);
    return {
      account: asPublicKey(record.account, `${itemLabel}.account`),
      mint: asPublicKey(record.mint, `${itemLabel}.mint`),
      amount: BigInt(amount),
    };
  });
}

function finalizedInstructions(value: unknown, label: string): readonly FinalizedInstruction[] {
  if (!Array.isArray(value)) evidenceInput(`${label} must be an array`);
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const record = asRecord(entry, itemLabel);
    rejectExtraKeys(record, ['programId', 'accounts', 'data'], itemLabel);
    const encoded = asString(record.data, `${itemLabel}.data`);
    const data = decodeBase58(encoded);
    if (data.length < 8) evidenceInput(`${itemLabel}.data has no instruction discriminator`);
    return {
      programId: asPublicKey(record.programId, `${itemLabel}.programId`),
      accounts: publicKeyArray(record.accounts, `${itemLabel}.accounts`),
      data,
    };
  });
}

function decodeFinalizedTransaction(value: unknown, scenario: DevnetScenario['id']): DecodedFinalizedTransaction {
  const label = `devnet E2E ${scenario} transaction`;
  const record = asRecord(value, label);
  if (
    record.instructions === undefined
    || record.preBalances === undefined
    || record.postBalances === undefined
    || record.preTokenBalances === undefined
    || record.postTokenBalances === undefined
  ) {
    evidenceInput(`${label} lacks decoded instructions and balance effects`);
  }
  const accountKeys = publicKeyArray(record.accountKeys, `${label}.accountKeys`);
  if (new Set(accountKeys).size !== accountKeys.length) evidenceInput(`${label}.accountKeys contains duplicates`);
  const instructions = finalizedInstructions(record.instructions, `${label}.instructions`);
  for (const instruction of instructions) {
    if (instruction.accounts.some((account) => !accountKeys.includes(account))) {
      evidenceInput(`${label} instruction references an account outside accountKeys`);
    }
  }
  const preTokenBalances = tokenBalances(record.preTokenBalances, `${label}.preTokenBalances`);
  const postTokenBalances = tokenBalances(record.postTokenBalances, `${label}.postTokenBalances`);
  if ([...preTokenBalances, ...postTokenBalances].some((balance) => !accountKeys.includes(balance.account))) {
    evidenceInput(`${label} token effect references an account outside accountKeys`);
  }
  return {
    accountKeys,
    instructions,
    preBalances: balanceArray(record.preBalances, `${label}.preBalances`, accountKeys.length),
    postBalances: balanceArray(record.postBalances, `${label}.postBalances`, accountKeys.length),
    preTokenBalances,
    postTokenBalances,
  };
}

function instructionKind(instruction: FinalizedInstruction, label: string): VerifiedInstructionKind {
  for (const kind of [
    'place_position',
    'calculate_position_entitlement',
    'timeout_void',
    'claim_position',
    'claim_position_for',
  ] as const) {
    if (instruction.data.subarray(0, 8).equals(instructionDiscriminator(kind))) return kind;
  }
  evidenceInput(`${label} uses an unsupported escrow instruction`);
}

function accountAt(instruction: FinalizedInstruction, index: number, label: string): string {
  const account = instruction.accounts[index];
  if (account === undefined) evidenceInput(`${label} is missing required account ${index}`);
  return account;
}

function solDelta(transaction: DecodedFinalizedTransaction, address: string, label: string): bigint {
  const index = transaction.accountKeys.indexOf(address);
  if (index < 0) evidenceInput(`${label} is absent from transaction account keys`);
  const before = transaction.preBalances[index];
  const after = transaction.postBalances[index];
  if (before === undefined || after === undefined) evidenceInput(`${label} balance effect is missing`);
  return after - before;
}

function tokenAmount(balances: readonly TokenBalance[], account: string, mint: string): bigint {
  const matches = balances.filter((balance) => balance.account === account && balance.mint === mint);
  if (matches.length > 1) evidenceInput(`token balance metadata duplicates ${account}`);
  return matches[0]?.amount ?? 0n;
}

function verifyPlacement(
  report: DevnetE2eReport,
  manifest: ReleaseManifest,
  scenario: DevnetScenario,
  transaction: DecodedFinalizedTransaction,
  instruction: FinalizedInstruction,
  expectedAsset: 'sol' | 'usdc',
): void {
  const label = `devnet E2E ${scenario.id}`;
  const expectedMarket = deterministicMarket(report.runId, scenario.id, report.releaseIdentity.programId);
  if (instruction.data.length !== PLACE_POSITION_DATA_LENGTH) evidenceInput(`${label} place_position data length is invalid`);
  if (!instruction.data.subarray(8, 24).equals(expectedMarket.uuidBytes)) evidenceInput(`${label} is bound to a different deterministic market`);
  if (accountAt(instruction, 1, label) !== expectedMarket.address) evidenceInput(`${label} market account does not match its run ID and scenario`);
  const amount = instruction.data.readBigUInt64LE(25);
  const expectedAmount = BigInt(expectedAsset === 'sol' ? manifest.config.minSolPosition : manifest.config.minUsdcPosition);
  if (amount !== expectedAmount) evidenceInput(`${label} position amount does not match the release minimum`);
  const asset = instruction.data[33];
  if (asset !== (expectedAsset === 'sol' ? 0 : 1)) evidenceInput(`${label} position uses the wrong asset`);
  const vault = accountAt(instruction, 6, `${label} place_position`);
  if (expectedAsset === 'sol') {
    if (solDelta(transaction, vault, `${label} vault`) !== amount) evidenceInput(`${label} has no exact SOL vault deposit effect`);
    return;
  }
  const mint = accountAt(instruction, 8, `${label} place_position`);
  if (mint !== manifest.config.canonicalUsdcMint) evidenceInput(`${label} token mint is not canonical devnet USDC`);
  const before = tokenAmount(transaction.preTokenBalances, vault, mint);
  const after = tokenAmount(transaction.postTokenBalances, vault, mint);
  if (after - before !== amount) evidenceInput(`${label} has no exact USDC vault deposit effect`);
}

function verifyClaim(
  report: DevnetE2eReport,
  scenario: DevnetScenario,
  transaction: DecodedFinalizedTransaction,
  instructions: readonly FinalizedInstruction[],
  firstKind: 'calculate_position_entitlement' | 'timeout_void',
  claimKind: 'claim_position' | 'claim_position_for',
): void {
  const label = `devnet E2E ${scenario.id}`;
  const expectedMarket = deterministicMarket(report.runId, scenario.id, report.releaseIdentity.programId).address;
  const first = instructions[0];
  const claim = instructions[1];
  if (first === undefined || claim === undefined) evidenceInput(`${label} instruction sequence is incomplete`);
  if (instructionKind(first, label) !== firstKind || instructionKind(claim, label) !== claimKind) {
    evidenceInput(`${label} instruction sequence does not match the required scenario`);
  }
  if (first.data.length !== 8 || claim.data.length !== 8) evidenceInput(`${label} contains unexpected instruction arguments`);
  const firstMarketIndex = 0;
  const claimMarketIndex = claimKind === 'claim_position' ? 0 : 1;
  if (accountAt(first, firstMarketIndex, label) !== expectedMarket || accountAt(claim, claimMarketIndex, label) !== expectedMarket) {
    evidenceInput(`${label} claim is bound to a different deterministic market`);
  }
  const ownerIndex = claimKind === 'claim_position' ? 2 : 3;
  const vaultIndex = claimKind === 'claim_position' ? 3 : 4;
  const owner = accountAt(claim, ownerIndex, label);
  const vault = accountAt(claim, vaultIndex, label);
  if (solDelta(transaction, vault, `${label} vault`) >= 0n || solDelta(transaction, owner, `${label} owner`) <= 0n) {
    evidenceInput(`${label} has no observable SOL claim transfer effect`);
  }
}

function verifyScenarioTransaction(
  report: DevnetE2eReport,
  manifest: ReleaseManifest,
  scenario: DevnetScenario,
  value: unknown,
): void {
  const transaction = decodeFinalizedTransaction(value, scenario.id);
  const instructions = transaction.instructions.filter((instruction) => instruction.programId === report.releaseIdentity.programId);
  const kinds = instructions.map((instruction) => instructionKind(instruction, `devnet E2E ${scenario.id}`));
  switch (scenario.id) {
    case 'real-sol-position':
    case 'relayer-retry-recovery': {
      const instruction = instructions[0];
      if (kinds.length !== 1 || kinds[0] !== 'place_position' || instruction === undefined) evidenceInput(`devnet E2E ${scenario.id} must contain exactly place_position`);
      verifyPlacement(report, manifest, scenario, transaction, instruction, 'sol');
      return;
    }
    case 'real-usdc-position': {
      const instruction = instructions[0];
      if (kinds.length !== 1 || kinds[0] !== 'place_position' || instruction === undefined) evidenceInput(`devnet E2E ${scenario.id} must contain exactly place_position`);
      verifyPlacement(report, manifest, scenario, transaction, instruction, 'usdc');
      return;
    }
    case 'settlement-and-claim':
    case 'telegram-privy-receipt': {
      if (kinds.length !== 2) evidenceInput(`devnet E2E ${scenario.id} must contain exactly calculate and claim`);
      verifyClaim(report, scenario, transaction, instructions, 'calculate_position_entitlement', 'claim_position_for');
      return;
    }
    case 'direct-claim-engine-down': {
      if (kinds.length !== 2) evidenceInput(`devnet E2E ${scenario.id} must contain exactly calculate and direct claim`);
      verifyClaim(report, scenario, transaction, instructions, 'calculate_position_entitlement', 'claim_position');
      return;
    }
    case 'paused-timeout-void': {
      if (kinds.length !== 2) evidenceInput(`devnet E2E ${scenario.id} must contain exactly timeout and claim`);
      verifyClaim(report, scenario, transaction, instructions, 'timeout_void', 'claim_position_for');
      return;
    }
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
  manifest: ReleaseManifest,
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
    verifyScenarioTransaction(report, manifest, scenario, transaction);
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
  await verifyDevnetTransactions(report, input.rpc, input.manifest);
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
  readonly payoutDifferential: PayoutDifferentialEvidenceReceipt;
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
    payoutDifferential: parsePayoutDifferentialEvidenceReceipt(input.payoutDifferential),
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
    'payoutDifferential',
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
    payoutDifferential: parsePayoutDifferentialEvidenceReceipt(root.payoutDifferential),
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
