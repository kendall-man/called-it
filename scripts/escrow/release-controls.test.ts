import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEVNET_SCENARIOS,
  createDevnetEvidence,
  createLocalValidatorEvidence,
  evidenceSigningPayload,
  releaseIdentity,
} from './evidence.js';
import { verifyIdlPolicy } from './idl-policy.js';
import { approvalBundleDigest, verifyMainnetEvidence, type MainnetGateContext } from './mainnet-gate.js';
import { buildProvenance, parseReleaseManifest } from './manifest.js';
import { formatOpsStatus } from './ops-status.js';
import { createPayoutDifferentialEvidenceReceipt } from './payout-differential-evidence.js';
import {
  CLASSIC_TOKEN_PROGRAM,
  UPGRADEABLE_LOADER,
  findProgramAddress,
  verifyRelease,
} from './release.js';
import { EscrowControlError, EXIT, type BuildManifest, type EvidenceRpcReader, type ReleaseManifest, type RpcAccount } from './types.js';
import { bigintLe, decodeBase58, encodeBase58, sha256, sha256Tree, stableJson } from './util.js';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

async function fixtureJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(fixture(name), 'utf8')) as unknown;
}

async function payoutDifferentialFixture(sourceCommit: string) {
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
  return createPayoutDifferentialEvidenceReceipt({
    sourceCommit,
    corpusBytes,
    rustResult: language('rust'),
    typescriptResult: language('typescript'),
  });
}

function key(byte: number): string {
  return encodeBase58(Buffer.alloc(32, byte));
}

function discriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

function u64(value: string): Buffer {
  return bigintLe(BigInt(value));
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function instructionDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function scenarioMarket(runId: string, scenario: (typeof DEVNET_SCENARIOS)[number], programId: string): {
  readonly address: string;
  readonly uuidBytes: Buffer;
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
    address: findProgramAddress([Buffer.from('market'), uuidBytes], programId).address,
    uuidBytes,
  };
}

function scenarioTransaction(
  manifest: ReleaseManifest,
  runId: string,
  scenario: (typeof DEVNET_SCENARIOS)[number],
  blockTime: number,
) {
  const market = scenarioMarket(runId, scenario, manifest.programId);
  const owner = key(20);
  const vault = key(21);
  const payer = key(22);
  const base = {
    slot: 100,
    blockTime,
    preTokenBalances: [] as Array<{ account: string; mint: string; amount: string }>,
    postTokenBalances: [] as Array<{ account: string; mint: string; amount: string }>,
  };
  if (scenario === 'real-sol-position' || scenario === 'real-usdc-position' || scenario === 'relayer-retry-recovery') {
    const asset = scenario === 'real-usdc-position' ? 'usdc' : 'sol';
    const amount = BigInt(asset === 'sol' ? manifest.config.minSolPosition : manifest.config.minUsdcPosition);
    const data = Buffer.alloc(126);
    instructionDiscriminator('place_position').copy(data, 0);
    market.uuidBytes.copy(data, 8);
    data.writeBigUInt64LE(amount, 25);
    data[33] = asset === 'sol' ? 0 : 1;
    const accounts = [
      manifest.configPda,
      market.address,
      payer,
      owner,
      key(23),
      key(24),
      vault,
      owner,
      manifest.config.canonicalUsdcMint,
      manifest.config.allowedTokenProgram,
      key(25),
    ];
    const accountKeys = [...new Set([manifest.programId, ...accounts])];
    const preBalances = accountKeys.map(() => 10_000_000);
    const postBalances = [...preBalances];
    const vaultIndex = accountKeys.indexOf(vault);
    const vaultBalance = preBalances[vaultIndex];
    if (vaultBalance === undefined) throw new Error('vault balance fixture is missing');
    if (asset === 'sol') {
      postBalances[vaultIndex] = vaultBalance + Number(amount);
    } else {
      base.preTokenBalances.push({ account: vault, mint: manifest.config.canonicalUsdcMint, amount: '10' });
      base.postTokenBalances.push({ account: vault, mint: manifest.config.canonicalUsdcMint, amount: (10n + amount).toString() });
    }
    return {
      ...base,
      accountKeys,
      preBalances,
      postBalances,
      instructions: [{ programId: manifest.programId, accounts, data: encodeBase58(data) }],
    };
  }

  const direct = scenario === 'direct-claim-engine-down';
  const timeout = scenario === 'paused-timeout-void';
  const firstAccounts = timeout ? [market.address] : [market.address, key(23)];
  const claimAccounts = direct
    ? [market.address, key(23), owner, vault, key(24), owner, manifest.config.allowedTokenProgram, key(25), key(26)]
    : [payer, market.address, key(23), owner, vault, key(24), owner, manifest.config.allowedTokenProgram, key(25), key(26)];
  const accountKeys = [...new Set([manifest.programId, ...firstAccounts, ...claimAccounts])];
  const preBalances = accountKeys.map(() => 10_000_000);
  const postBalances = [...preBalances];
  const vaultIndex = accountKeys.indexOf(vault);
  const ownerIndex = accountKeys.indexOf(owner);
  const vaultBalance = preBalances[vaultIndex];
  const ownerBalance = preBalances[ownerIndex];
  if (vaultBalance === undefined || ownerBalance === undefined) throw new Error('claim balance fixture is missing');
  postBalances[vaultIndex] = vaultBalance - 1_000_000;
  postBalances[ownerIndex] = ownerBalance + 1_000_000;
  return {
    ...base,
    accountKeys,
    preBalances,
    postBalances,
    instructions: [
      {
        programId: manifest.programId,
        accounts: firstAccounts,
        data: encodeBase58(instructionDiscriminator(timeout ? 'timeout_void' : 'calculate_position_entitlement')),
      },
      {
        programId: manifest.programId,
        accounts: claimAccounts,
        data: encodeBase58(instructionDiscriminator(direct ? 'claim_position' : 'claim_position_for')),
      },
    ],
  };
}

function configData(manifest: ReleaseManifest, bump: number): Buffer {
  const config = manifest.config;
  return Buffer.concat([
    discriminator('ProtocolConfig'),
    Buffer.from([config.custodyVersion, bump, config.paused ? 1 : 0]),
    ...[
      config.configAuthority,
      config.pauseAuthority,
      config.marketCreationAuthority,
      config.feedOperatorAuthority,
      config.oracleSet,
      config.relayerFeePayer,
      config.residualRecipient,
    ].map(decodeBase58),
    decodeBase58(manifest.clusterGenesisHash),
    decodeBase58(config.canonicalUsdcMint),
    decodeBase58(config.allowedTokenProgram),
    u64(config.maxSolPosition),
    u64(config.maxUsdcPosition),
    u64(config.minSolPosition),
    u64(config.minUsdcPosition),
    u64(config.maxMarketDurationSeconds),
    u64(config.maxResolutionDelaySeconds),
  ]);
}

function oracleData(manifest: ReleaseManifest, bump: number): Buffer {
  const oracle = manifest.oracleSet;
  return Buffer.concat([
    discriminator('OracleSet'),
    Buffer.from([oracle.custodyVersion, bump]),
    u64(oracle.epoch),
    u32(3),
    ...oracle.signers.map(decodeBase58),
    Buffer.from([2]),
    u64(oracle.activationSlot),
    Buffer.from([0]),
    Buffer.alloc(8),
  ]);
}

function account(owner: string, data: Buffer, executable = false): RpcAccount {
  return { owner, data, executable, lamports: 1 };
}

function buildReleaseFixture(options: {
  readonly network?: ReleaseManifest['network'];
  readonly build?: BuildManifest;
  readonly sbf?: Buffer;
  readonly transactionBlockTime?: number;
  readonly evidenceRunId?: string;
} = {}): { readonly manifest: ReleaseManifest; readonly build: BuildManifest; readonly rpc: EvidenceRpcReader; readonly accounts: Map<string, RpcAccount>; readonly sbf: Buffer } {
  const network = options.network ?? 'localnet';
  const programId = options.build?.programId ?? key(1);
  const sbf = options.sbf ?? Buffer.from('fake-sbf-without-secrets');
  const config = findProgramAddress([Buffer.from('config')], programId);
  const oracle = findProgramAddress([Buffer.from('oracle-set'), bigintLe(1n)], programId);
  const build: BuildManifest = options.build ?? {
    schemaVersion: 1,
    sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    programId,
    sbfSha256: sha256(sbf),
    idlSha256: '2'.repeat(64),
    sourceSha256: '3'.repeat(64),
    lockSha256: '4'.repeat(64),
  };
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    network,
    clusterGenesisHash: network === 'mainnet-beta'
      ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
      : network === 'devnet'
        ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
        : key(2),
    programId,
    upgradeableLoaderProgramId: UPGRADEABLE_LOADER,
    programDataAddress: key(3),
    upgradeAuthority: key(4),
    configPda: config.address,
    build,
    config: {
      custodyVersion: 1,
      paused: false,
      configAuthority: key(5),
      pauseAuthority: key(6),
      marketCreationAuthority: key(7),
      feedOperatorAuthority: key(8),
      oracleSet: oracle.address,
      relayerFeePayer: key(9),
      residualRecipient: key(10),
      canonicalUsdcMint: network === 'mainnet-beta'
        ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
        : network === 'devnet'
          ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
          : key(11),
      allowedTokenProgram: CLASSIC_TOKEN_PROGRAM,
      minSolPosition: '1000000',
      maxSolPosition: '50000000',
      minUsdcPosition: '1000000',
      maxUsdcPosition: '25000000',
      maxMarketDurationSeconds: '86400',
      maxResolutionDelaySeconds: '21600',
    },
    oracleSet: {
      address: oracle.address,
      custodyVersion: 1,
      epoch: '1',
      signers: [key(12), key(13), key(14)],
      threshold: 2,
      activationSlot: '10',
      retirementSlot: null,
    },
  };
  const program = Buffer.alloc(36);
  program.writeUInt32LE(2, 0);
  decodeBase58(manifest.programDataAddress).copy(program, 4);
  const programData = Buffer.alloc(45 + sbf.length + 16);
  programData.writeUInt32LE(3, 0);
  programData.writeBigUInt64LE(10n, 4);
  programData[12] = 1;
  decodeBase58(manifest.upgradeAuthority).copy(programData, 13);
  sbf.copy(programData, 45);
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  const accounts = new Map<string, RpcAccount>([
    [manifest.programId, account(UPGRADEABLE_LOADER, program, true)],
    [manifest.programDataAddress, account(UPGRADEABLE_LOADER, programData)],
    [manifest.configPda, account(programId, configData(manifest, config.bump))],
    [manifest.oracleSet.address, account(programId, oracleData(manifest, oracle.bump))],
    [manifest.config.canonicalUsdcMint, account(CLASSIC_TOKEN_PROGRAM, mint)],
  ]);
  const rpc: EvidenceRpcReader = {
    async genesisHash() { return manifest.clusterGenesisHash; },
    async account(address: string) {
      const found = accounts.get(address);
      if (found === undefined) throw new Error('missing fake account');
      return found;
    },
    async finalizedTransaction(signature: string) {
      if (options.evidenceRunId !== undefined) {
        const scenario = DEVNET_SCENARIOS[(decodeBase58(signature)[0] ?? 0) - 1];
        if (scenario === undefined) throw new Error('unknown fake scenario signature');
        return scenarioTransaction(
          manifest,
          options.evidenceRunId,
          scenario,
          options.transactionBlockTime ?? 1_786_000_000,
        );
      }
      return {
        slot: 100,
        blockTime: options.transactionBlockTime ?? 1_786_000_000,
        accountKeys: [manifest.programId],
      };
    },
  };
  return { manifest, build, rpc, accounts, sbf };
}

interface TestSigner {
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

interface EvidenceBundleFixture {
  readonly directory: string;
  readonly evidence: Record<string, any>;
  readonly context: MainnetGateContext;
  readonly paths: Readonly<Record<string, string>>;
}

function testSigner(): TestSigner {
  const pair = generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ format: 'der', type: 'spki' });
  return { publicKey: encodeBase58(der.subarray(-32)), privateKey: pair.privateKey };
}

function signedStatement(signer: TestSigner, value: Record<string, unknown>): Record<string, unknown> {
  const unsigned = { ...value, signerPublicKey: signer.publicKey };
  return {
    ...unsigned,
    signature: encodeBase58(sign(null, evidenceSigningPayload(unsigned), signer.privateKey)),
  };
}

function machineEvidenceEnvelope(
  signer: TestSigner,
  identity: ReturnType<typeof releaseIdentity>,
  output: unknown,
): Record<string, unknown> {
  return signedStatement(signer, {
    schemaVersion: 1,
    kind: 'machine-evidence-envelope',
    releaseIdentity: identity,
    outputSha256: sha256(stableJson(output)),
    output,
  });
}

async function writeArtifact(
  directory: string,
  name: string,
  value: unknown,
): Promise<{ readonly path: string; readonly sha256: string }> {
  const bytes = Buffer.isBuffer(value)
    ? value
    : typeof value === 'string'
      ? Buffer.from(value)
      : Buffer.from(stableJson(value));
  await writeFile(join(directory, name), bytes);
  return { path: name, sha256: sha256(bytes) };
}

async function evidenceBundleFixture(options: {
  readonly staleLocal?: boolean;
  readonly payoutSourceCommit?: string;
  readonly omitPayoutDifferential?: boolean;
} = {}): Promise<EvidenceBundleFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'escrow-mainnet-evidence-'));
  const source = join(directory, 'source');
  const suite = join(directory, 'suite');
  const controls = join(directory, 'controls');
  await Promise.all([mkdir(source), mkdir(suite), mkdir(controls)]);
  const programSo = join(directory, 'mainnet.so');
  const idlPath = join(directory, 'mainnet-idl.json');
  const lock = join(directory, 'Cargo.lock');
  const idl = await fixtureJson('idl-policy-pass.example.json');
  await Promise.all([
    writeFile(programSo, 'bound-sbf'),
    writeFile(idlPath, stableJson(idl)),
    writeFile(lock, 'locked\n'),
    writeFile(join(source, 'lib.rs'), 'pub fn escrow() {}\n'),
    writeFile(join(suite, 'local-validator.integration.test.ts'), 'required suite\n'),
    writeFile(join(controls, 'gate.ts'), 'required controls\n'),
  ]);
  const build = await buildProvenance('a'.repeat(40), { programSo, idl: idlPath, source, lock });
  const sbf = await readFile(programSo);
  const transactionBlockTime = Date.parse('2026-07-15T08:45:00Z') / 1_000;
  const mainnet = buildReleaseFixture({ network: 'mainnet-beta', build, sbf });
  const devnet = buildReleaseFixture({
    network: 'devnet',
    build,
    sbf,
    transactionBlockTime,
    evidenceRunId: 'devnet-run-2026-07-15',
  });
  const local = buildReleaseFixture({ network: 'localnet', build, sbf });
  const localVerification = await verifyRelease(local.manifest, build, local.rpc, sbf);
  const localStart = options.staleLocal ? '2026-07-09T09:00:00Z' : '2026-07-15T09:00:00Z';
  const localComplete = options.staleLocal ? '2026-07-09T09:30:00Z' : '2026-07-15T09:30:00Z';
  const localReceipt = createLocalValidatorEvidence({
    releaseManifest: local.manifest,
    verificationChecks: localVerification.checks,
    suiteSha256: await sha256Tree(suite),
    controlsSha256: await sha256Tree(controls),
    payoutDifferential: await payoutDifferentialFixture(options.payoutSourceCommit ?? build.sourceCommit),
    startedAt: localStart,
    completedAt: localComplete,
    verifiedAt: localComplete,
  });
  const devnetReport = {
    schemaVersion: 1,
    kind: 'devnet-e2e-report',
    releaseIdentity: releaseIdentity(devnet.manifest),
    startedAt: '2026-07-15T08:30:00Z',
    completedAt: '2026-07-15T09:00:00Z',
    runId: 'devnet-run-2026-07-15',
    scenarios: DEVNET_SCENARIOS.map((id, index) => ({
      id,
      transactionSignature: encodeBase58(Buffer.alloc(64, index + 1)),
      observedAt: '2026-07-15T08:45:00Z',
    })),
  };
  const devnetReportRef = await writeArtifact(directory, 'devnet-report.json', devnetReport);
  const devnetReceipt = await createDevnetEvidence({
    manifest: devnet.manifest,
    build,
    rpc: devnet.rpc,
    localSbf: sbf,
    report: devnetReport,
    reportSha256: devnetReportRef.sha256,
    verifiedAt: '2026-07-15T09:05:00Z',
  });

  const operations = testSigner();
  const independentReview = testSigner();
  const externalAudit = testSigner();
  const authority = testSigner();
  const approval = testSigner();
  const identity = releaseIdentity(mainnet.manifest);
  const [legacyReport, reviewReport, auditReport, authorityReport] = await Promise.all([
    writeArtifact(directory, 'legacy-report.txt', 'legacy liabilities and withdrawals reconciled\n'),
    writeArtifact(directory, 'independent-review.txt', 'independent review closure\n'),
    writeArtifact(directory, 'external-audit.txt', 'external audit closure\n'),
    writeArtifact(directory, 'authority-report.txt', 'multisig authority inspection\n'),
  ]);
  const legacyStatement = signedStatement(operations, {
    schemaVersion: 1,
    kind: 'legacy-audit',
    releaseIdentity: identity,
    reportSha256: legacyReport.sha256,
    auditor: 'Called It operations control',
    auditId: 'legacy-2026-07-15',
    issuedAt: '2026-07-14T10:00:00Z',
    closedAt: '2026-07-15T07:00:00Z',
    withdrawalsAvailable: true,
    noAutoMigration: true,
    newCustodyIntakeDisabled: true,
    liabilityDriftAtomic: '0',
  });
  const reviewStatement = signedStatement(independentReview, {
    schemaVersion: 1,
    kind: 'independent-review',
    releaseIdentity: identity,
    reportSha256: reviewReport.sha256,
    issuer: 'Independent reviewer',
    reportId: 'review-2026-07-15',
    scope: 'calledit escrow mainnet program and release',
    issuedAt: '2026-07-13T10:00:00Z',
    closedAt: '2026-07-15T07:30:00Z',
    criticalOpen: 0,
    highOpen: 0,
  });
  const auditStatement = signedStatement(externalAudit, {
    schemaVersion: 1,
    kind: 'external-audit',
    releaseIdentity: identity,
    reportSha256: auditReport.sha256,
    issuer: 'External audit firm',
    reportId: 'audit-2026-07-15',
    scope: 'calledit escrow mainnet program and release',
    issuedAt: '2026-07-12T10:00:00Z',
    closedAt: '2026-07-15T08:00:00Z',
    criticalOpen: 0,
    highOpen: 0,
  });
  const multisigMembers = [key(20), key(21), key(22)];
  const authorityStatement = signedStatement(authority, {
    schemaVersion: 1,
    kind: 'authority-provenance',
    releaseIdentity: identity,
    reportSha256: authorityReport.sha256,
    verifier: 'Release authority verifier',
    recordId: 'authorities-2026-07-15',
    verifiedAt: '2026-07-15T09:15:00Z',
    roles: [
      ['upgrade', mainnet.manifest.upgradeAuthority],
      ['config', mainnet.manifest.config.configAuthority],
      ['pause', mainnet.manifest.config.pauseAuthority],
      ['market_creation', mainnet.manifest.config.marketCreationAuthority],
      ['feed_operator', mainnet.manifest.config.feedOperatorAuthority],
    ].map(([role, address]) => ({ role, address, threshold: 2, members: multisigMembers })),
  });
  (authorityStatement.roles as unknown[]).push({
    role: 'oracle_set',
    address: mainnet.manifest.oracleSet.address,
    threshold: 2,
    members: mainnet.manifest.oracleSet.signers,
  });
  // The roles are part of the signed payload, so re-sign after adding the oracle set.
  const finalAuthorityStatement = signedStatement(authority, Object.fromEntries(
    Object.entries(authorityStatement).filter(([field]) => !['signerPublicKey', 'signature'].includes(field)),
  ));

  const releaseManifestRef = await writeArtifact(directory, 'mainnet-release.json', mainnet.manifest);
  const localOutput = options.omitPayoutDifferential
    ? Object.fromEntries(Object.entries(localReceipt).filter(([field]) => field !== 'payoutDifferential'))
    : localReceipt;
  const localRef = await writeArtifact(
    directory,
    'local-validator.json',
    machineEvidenceEnvelope(operations, releaseIdentity(local.manifest), localOutput),
  );
  const devnetEvidenceRef = await writeArtifact(directory, 'devnet-evidence.json', devnetReceipt);
  const devnetProgramRef = await writeArtifact(directory, 'devnet.so', sbf);
  const devnetIdlRef = await writeArtifact(directory, 'devnet-idl.json', idl);
  const legacyStatementRef = await writeArtifact(directory, 'legacy-statement.json', legacyStatement);
  const reviewStatementRef = await writeArtifact(directory, 'review-statement.json', reviewStatement);
  const auditStatementRef = await writeArtifact(directory, 'audit-statement.json', auditStatement);
  const authorityStatementRef = await writeArtifact(directory, 'authority-statement.json', finalAuthorityStatement);
  const soakSamples = [];
  for (let day = 9; day <= 15; day += 1) {
    const capturedAt = `2026-07-${String(day).padStart(2, '0')}T06:00:00Z`;
    const sample = structuredClone(await fixtureJson('ops-status-healthy.example.json')) as Record<string, unknown>;
    sample.cluster = 'devnet';
    sample.capturedAt = capturedAt;
    soakSamples.push({
      capturedAt,
      clusterGenesisHash: devnet.manifest.clusterGenesisHash,
      programId: devnet.manifest.programId,
      releaseManifestSha256: releaseIdentity(devnet.manifest).releaseManifestSha256,
      artifact: await writeArtifact(
        directory,
        `soak-${day}.json`,
        machineEvidenceEnvelope(operations, releaseIdentity(devnet.manifest), sample),
      ),
    });
  }
  const evidence: Record<string, any> = {
    schemaVersion: 2,
    network: 'mainnet-beta',
    releaseIdentity: identity,
    artifacts: {
      releaseManifest: releaseManifestRef,
      localValidator: localRef,
      devnetEvidence: devnetEvidenceRef,
      devnetReport: devnetReportRef,
      devnetProgramSo: devnetProgramRef,
      devnetIdl: devnetIdlRef,
      legacyAuditStatement: legacyStatementRef,
      legacyAuditReport: legacyReport,
      independentReviewStatement: reviewStatementRef,
      independentReviewReport: reviewReport,
      externalAuditStatement: auditStatementRef,
      externalAuditReport: auditReport,
      authorityStatement: authorityStatementRef,
      authorityReport,
      soakSamples,
      approvalStatement: { path: 'approval-placeholder.json', sha256: '0'.repeat(64) },
    },
    canary: {
      allowlistEnabled: true,
      groupCount: 1,
      minSolPosition: mainnet.manifest.config.minSolPosition,
      maxSolPosition: mainnet.manifest.config.maxSolPosition,
      minUsdcPosition: mainnet.manifest.config.minUsdcPosition,
      maxUsdcPosition: mainnet.manifest.config.maxUsdcPosition,
    },
  };
  const approvalStatement = signedStatement(approval, {
    schemaVersion: 1,
    kind: 'mainnet-approval',
    releaseIdentity: identity,
    bundleSha256: approvalBundleDigest(evidence),
    scope: 'mainnet escrow canary value enablement',
    approver: 'Called It release authority',
    approvalId: 'mainnet-canary-2026-07-15',
    approvedAt: '2026-07-15T11:55:00Z',
  });
  evidence.artifacts.approvalStatement = await writeArtifact(directory, 'approval-statement.json', approvalStatement);
  const context: MainnetGateContext = {
    manifest: mainnet.manifest,
    localBuild: build,
    mainnetRpc: mainnet.rpc,
    mainnetSbf: sbf,
    mainnetIdl: idl,
    devnetRpc: devnet.rpc,
    sourcePath: source,
    lockPath: lock,
    artifactRoot: directory,
    integrationSuitePath: suite,
    controlsPath: controls,
    trustedSigners: {
      operations: operations.publicKey,
      independentReview: independentReview.publicKey,
      externalAudit: externalAudit.publicKey,
      authority: authority.publicKey,
      approval: approval.publicKey,
    },
    now: new Date('2026-07-15T12:00:00Z'),
  };
  return {
    directory,
    evidence,
    context,
    paths: {
      legacyReport: join(directory, legacyReport.path),
      devnetReport: join(directory, devnetReportRef.path),
      devnetEvidence: join(directory, devnetEvidenceRef.path),
      localValidator: join(directory, localRef.path),
    },
  };
}

test('build provenance is deterministic and changes when source changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'escrow-controls-'));
  const source = join(directory, 'source');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(source));
  const programSo = join(directory, 'program.so');
  const idl = join(directory, 'idl.json');
  const lock = join(directory, 'Cargo.lock');
  await Promise.all([
    writeFile(programSo, 'sbf'),
    writeFile(idl, JSON.stringify({ address: key(1), instructions: [] })),
    writeFile(lock, 'locked'),
    writeFile(join(source, 'lib.rs'), 'fn main() {}\n'),
  ]);
  const paths = { programSo, idl, source, lock };
  const first = await buildProvenance('a'.repeat(40), paths);
  const second = await buildProvenance('a'.repeat(40), paths);
  assert.deepEqual(first, second);
  await writeFile(join(source, 'lib.rs'), 'fn changed() {}\n');
  const changed = await buildProvenance('a'.repeat(40), paths);
  assert.notEqual(changed.sourceSha256, first.sourceSha256);
});

test('release verification checks exact deployed accounts and artifacts', async () => {
  const { manifest, build, rpc, sbf } = buildReleaseFixture();
  const result = await verifyRelease(manifest, build, rpc, sbf);
  assert.equal(result.ok, true);
  assert.ok(result.checks.includes('decoded protocol config'));
});

test('release verification fails closed on a tampered config account', async () => {
  const fixtureData = buildReleaseFixture();
  const config = fixtureData.accounts.get(fixtureData.manifest.configPda)!;
  const tampered = Buffer.from(config.data);
  tampered[10] = 1;
  fixtureData.accounts.set(fixtureData.manifest.configPda, { ...config, data: tampered });
  await assert.rejects(
    verifyRelease(fixtureData.manifest, fixtureData.build, fixtureData.rpc, fixtureData.sbf),
    (error: unknown) => error instanceof EscrowControlError && error.exitCode === EXIT.mismatch,
  );
});

test('release verification rejects deployed SBF tampering', async () => {
  const fixtureData = buildReleaseFixture();
  const accountData = fixtureData.accounts.get(fixtureData.manifest.programDataAddress)!;
  const tampered = Buffer.from(accountData.data);
  tampered[45] = tampered[45]! ^ 1;
  fixtureData.accounts.set(fixtureData.manifest.programDataAddress, { ...accountData, data: tampered });
  await assert.rejects(
    verifyRelease(fixtureData.manifest, fixtureData.build, fixtureData.rpc, fixtureData.sbf),
    /deployed SBF bytes/,
  );
});

test('release manifest rejects an embedded credential-like field', async () => {
  const raw = await fixtureJson('release-manifest.example.json') as Record<string, unknown>;
  raw.apiToken = 'forbidden';
  assert.throws(() => parseReleaseManifest(raw), /credential-like field/);
});

test('devnet evidence rejects synthetic scenario labels without decoded instructions and effects', async () => {
  const fixtureData = buildReleaseFixture({
    network: 'devnet',
    transactionBlockTime: 1_768_465_800,
  });
  const report = {
    schemaVersion: 1,
    kind: 'devnet-e2e-report',
    releaseIdentity: releaseIdentity(fixtureData.manifest),
    startedAt: '2026-01-15T08:00:00Z',
    completedAt: '2026-01-15T09:00:00Z',
    runId: 'synthetic-label-run',
    scenarios: DEVNET_SCENARIOS.map((id, index) => ({
      id,
      transactionSignature: encodeBase58(Buffer.alloc(64, index + 1)),
      observedAt: '2026-01-15T08:30:00Z',
    })),
  };

  await assert.rejects(
    createDevnetEvidence({
      manifest: fixtureData.manifest,
      build: fixtureData.build,
      rpc: fixtureData.rpc,
      localSbf: fixtureData.sbf,
      report,
      reportSha256: sha256(stableJson(report)),
      verifiedAt: '2026-01-15T09:05:00Z',
    }),
    /decoded instructions and balance effects/,
  );
});

test('devnet evidence rejects relabeling valid scenario transactions', async () => {
  const runId = 'relabelled-run';
  const fixtureData = buildReleaseFixture({
    network: 'devnet',
    transactionBlockTime: 1_768_465_800,
    evidenceRunId: runId,
  });
  const signatures = DEVNET_SCENARIOS.map((_, index) => encodeBase58(Buffer.alloc(64, index + 1)));
  const firstSignature = signatures[0];
  const secondSignature = signatures[1];
  if (firstSignature === undefined || secondSignature === undefined) throw new Error('scenario signatures are missing');
  signatures[0] = secondSignature;
  signatures[1] = firstSignature;
  const report = {
    schemaVersion: 1,
    kind: 'devnet-e2e-report',
    releaseIdentity: releaseIdentity(fixtureData.manifest),
    startedAt: '2026-01-15T08:00:00Z',
    completedAt: '2026-01-15T09:00:00Z',
    runId,
    scenarios: DEVNET_SCENARIOS.map((id, index) => ({
      id,
      transactionSignature: signatures[index],
      observedAt: '2026-01-15T08:30:00Z',
    })),
  };

  await assert.rejects(
    createDevnetEvidence({
      manifest: fixtureData.manifest,
      build: fixtureData.build,
      rpc: fixtureData.rpc,
      localSbf: fixtureData.sbf,
      report,
      reportSha256: sha256(stableJson(report)),
      verifiedAt: '2026-01-15T09:05:00Z',
    }),
    /different deterministic market/,
  );
});

test('IDL policy accepts recovery paths and rejects arbitrary vault withdrawal', async () => {
  const good = await fixtureJson('idl-policy-pass.example.json');
  assert.equal(verifyIdlPolicy(good).ok, true);
  const bad = structuredClone(good) as { instructions: unknown[] };
  bad.instructions.push({
    name: 'admin_withdraw_vault',
    accounts: [{ name: 'admin_authority', signer: true }, { name: 'vault', writable: true }],
    args: [],
  });
  assert.throws(() => verifyIdlPolicy(bad), /forbidden vault-administration instruction/);
});

test('IDL policy rejects pause prerequisites on timeout recovery', async () => {
  const value = await fixtureJson('idl-policy-pass.example.json') as { instructions: Array<{ name: string; accounts: unknown[] }> };
  value.instructions.find((instruction) => instruction.name === 'timeout_void')!.accounts.push({ name: 'pause_authority', signer: true });
  assert.throws(() => verifyIdlPolicy(value), /pause prerequisite/);
});

test('mainnet gate verifies a live release and artifact-bound local/devnet evidence', async () => {
  const fixtureData = await evidenceBundleFixture();
  try {
    const result = await verifyMainnetEvidence(fixtureData.evidence, fixtureData.context);
    assert.equal(result.ok, true);
    assert.ok(result.checks.includes('live devnet release and finalized E2E transactions'));
    assert.equal(result.soakEnd, '2026-07-15T06:00:00Z');
  } finally {
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test('mainnet gate requires current release-bound payout differential evidence', async () => {
  const missing = await evidenceBundleFixture({ omitPayoutDifferential: true });
  try {
    await assert.rejects(
      verifyMainnetEvidence(missing.evidence, missing.context),
      /payout differential evidence receipt must be an object/,
    );
  } finally {
    await rm(missing.directory, { recursive: true, force: true });
  }

  const wrongCommit = await evidenceBundleFixture({ payoutSourceCommit: 'c'.repeat(40) });
  try {
    await assert.rejects(
      verifyMainnetEvidence(wrongCommit.evidence, wrongCommit.context),
      /payout differential evidence source commit differs from mainnet/,
    );
  } finally {
    await rm(wrongCommit.directory, { recursive: true, force: true });
  }
});

test('mainnet gate rejects unsigned local-validator and soak checklists', async () => {
  const localFixture = await evidenceBundleFixture();
  try {
    const localPath = localFixture.paths.localValidator;
    if (localPath === undefined) throw new Error('local-validator fixture path is missing');
    const envelope = JSON.parse(await readFile(localPath, 'utf8')) as { output: unknown };
    const unsignedRef = await writeArtifact(localFixture.directory, 'unsigned-local-validator.json', envelope.output);
    localFixture.evidence.artifacts.localValidator = unsignedRef;
    await assert.rejects(
      verifyMainnetEvidence(localFixture.evidence, localFixture.context),
      /machine evidence envelope/,
    );
  } finally {
    await rm(localFixture.directory, { recursive: true, force: true });
  }

  const soakFixture = await evidenceBundleFixture();
  try {
    const soakEntry = soakFixture.evidence.artifacts.soakSamples[0] as {
      artifact: { path: string; sha256: string };
    };
    const soakPath = join(soakFixture.directory, soakEntry.artifact.path);
    const envelope = JSON.parse(await readFile(soakPath, 'utf8')) as { output: unknown };
    soakEntry.artifact = await writeArtifact(soakFixture.directory, 'unsigned-soak.json', envelope.output);
    await assert.rejects(
      verifyMainnetEvidence(soakFixture.evidence, soakFixture.context),
      /soak sample 0 machine evidence envelope/,
    );
  } finally {
    await rm(soakFixture.directory, { recursive: true, force: true });
  }
});

test('mainnet gate rejects tampered signed checks and synthetic devnet check order', async () => {
  const localFixture = await evidenceBundleFixture();
  try {
    const localPath = localFixture.paths.localValidator;
    if (localPath === undefined) throw new Error('local-validator fixture path is missing');
    const envelope = JSON.parse(await readFile(localPath, 'utf8')) as { output: { verificationChecks: string[] } };
    envelope.output.verificationChecks = [...envelope.output.verificationChecks].reverse();
    localFixture.evidence.artifacts.localValidator = await writeArtifact(
      localFixture.directory,
      'tampered-local-validator.json',
      envelope,
    );
    await assert.rejects(
      verifyMainnetEvidence(localFixture.evidence, localFixture.context),
      /signature is invalid/,
    );
  } finally {
    await rm(localFixture.directory, { recursive: true, force: true });
  }

  const devnetFixture = await evidenceBundleFixture();
  try {
    const devnetPath = devnetFixture.paths.devnetEvidence;
    if (devnetPath === undefined) throw new Error('devnet evidence fixture path is missing');
    const receipt = JSON.parse(await readFile(devnetPath, 'utf8')) as { verificationChecks: string[] };
    receipt.verificationChecks = [...receipt.verificationChecks].reverse();
    devnetFixture.evidence.artifacts.devnetEvidence = await writeArtifact(
      devnetFixture.directory,
      'synthetic-devnet-checks.json',
      receipt,
    );
    await assert.rejects(
      verifyMainnetEvidence(devnetFixture.evidence, devnetFixture.context),
      /devnet evidence live verification checks mismatch/,
    );
  } finally {
    await rm(devnetFixture.directory, { recursive: true, force: true });
  }
});

test('mainnet gate rejects the fabricated v1 example even when caller flags say passed', async () => {
  const fixtureData = await evidenceBundleFixture();
  try {
    const fabricated = await fixtureJson('mainnet-evidence.example.json');
    await assert.rejects(
      verifyMainnetEvidence(fabricated, fixtureData.context),
      /legacy flag-only evidence is forbidden/,
    );
  } finally {
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test('mainnet gate rejects tampered and missing artifacts', async () => {
  const tampered = await evidenceBundleFixture();
  try {
    await writeFile(tampered.paths.legacyReport!, 'tampered report\n');
    await assert.rejects(verifyMainnetEvidence(tampered.evidence, tampered.context), /artifact SHA-256 mismatch/);
  } finally {
    await rm(tampered.directory, { recursive: true, force: true });
  }

  const missing = await evidenceBundleFixture();
  try {
    await rm(missing.paths.devnetReport!);
    await assert.rejects(verifyMainnetEvidence(missing.evidence, missing.context), /artifact is missing/);
  } finally {
    await rm(missing.directory, { recursive: true, force: true });
  }
});

test('mainnet gate rejects stale machine evidence and wrong release identity', async () => {
  const stale = await evidenceBundleFixture({ staleLocal: true });
  try {
    await assert.rejects(verifyMainnetEvidence(stale.evidence, stale.context), /local-validator evidence is stale/);
  } finally {
    await rm(stale.directory, { recursive: true, force: true });
  }

  const wrongIdentity = await evidenceBundleFixture();
  try {
    wrongIdentity.evidence.releaseIdentity.programId = key(31);
    await assert.rejects(verifyMainnetEvidence(wrongIdentity.evidence, wrongIdentity.context), /mainnet release identity mismatch/);
  } finally {
    await rm(wrongIdentity.directory, { recursive: true, force: true });
  }
});

test('mainnet gate rejects authority and approval provenance tampering', async () => {
  const fixtureData = await evidenceBundleFixture();
  try {
    const approvalPath = join(fixtureData.directory, fixtureData.evidence.artifacts.approvalStatement.path);
    const approval = JSON.parse(await readFile(approvalPath, 'utf8')) as Record<string, unknown>;
    approval.approver = 'fabricated approver';
    const approvalRef = await writeArtifact(fixtureData.directory, 'approval-tampered.json', approval);
    fixtureData.evidence.artifacts.approvalStatement = approvalRef;
    await assert.rejects(verifyMainnetEvidence(fixtureData.evidence, fixtureData.context), /signature is invalid/);
  } finally {
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test('ops status reports healthy state and fails on every critical class', async () => {
  const good = await fixtureJson('ops-status-healthy.example.json');
  assert.equal(formatOpsStatus(good).healthy, true);

  const cases: Array<[string, (value: any) => void]> = [
    ['drift', (value) => { value.assets.sol.vaultBalanceAtomic = '10000001'; }],
    ['signer', (value) => { value.signers.disagreement = true; }],
    ['relayer', (value) => { value.relayer.deadJobs = 1; }],
    ['unknown', (value) => { value.relayer.unknownJobs = 1; value.relayer.oldestUnknownAgeSeconds = 121; }],
    ['indexer', (value) => { value.indexer.cursorLagSlots = 21; }],
    ['rpc', (value) => { value.rpc.genesisMatch = false; }],
    ['claims', (value) => { value.claims.backlogCount = 21; }],
    ['fee', (value) => { value.relayer.feeBalanceLamports = '1'; }],
    ['legacy', (value) => { value.legacy.reconciledLiabilityAtomic = '29999999'; }],
  ];
  for (const [name, mutate] of cases) {
    const value = structuredClone(good);
    mutate(value);
    assert.equal(formatOpsStatus(value).healthy, false, name);
  }
});

test('ops input rejects credential-like fields instead of printing them', async () => {
  const value = await fixtureJson('ops-status-healthy.example.json') as Record<string, unknown>;
  value.authorization = 'Bearer should-never-be-logged';
  assert.throws(() => formatOpsStatus(value), /credential-like field/);
});
