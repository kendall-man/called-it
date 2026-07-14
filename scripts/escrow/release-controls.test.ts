import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyIdlPolicy } from './idl-policy.js';
import { verifyMainnetEvidence } from './mainnet-gate.js';
import { buildProvenance, parseReleaseManifest } from './manifest.js';
import { formatOpsStatus } from './ops-status.js';
import {
  CLASSIC_TOKEN_PROGRAM,
  UPGRADEABLE_LOADER,
  findProgramAddress,
  verifyRelease,
} from './release.js';
import { EscrowControlError, EXIT, type BuildManifest, type ReleaseManifest, type RpcAccount, type RpcReader } from './types.js';
import { bigintLe, decodeBase58, encodeBase58, sha256 } from './util.js';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

async function fixtureJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(fixture(name), 'utf8')) as unknown;
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

function buildReleaseFixture(): { readonly manifest: ReleaseManifest; readonly build: BuildManifest; readonly rpc: RpcReader; readonly accounts: Map<string, RpcAccount>; readonly sbf: Buffer } {
  const programId = key(1);
  const sbf = Buffer.from('fake-sbf-without-secrets');
  const config = findProgramAddress([Buffer.from('config')], programId);
  const oracle = findProgramAddress([Buffer.from('oracle-set'), bigintLe(1n)], programId);
  const build: BuildManifest = {
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
    network: 'localnet',
    clusterGenesisHash: key(2),
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
      canonicalUsdcMint: key(11),
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
  const rpc: RpcReader = {
    async genesisHash() { return manifest.clusterGenesisHash; },
    async account(address: string) {
      const found = accounts.get(address);
      if (found === undefined) throw new Error('missing fake account');
      return found;
    },
  };
  return { manifest, build, rpc, accounts, sbf };
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

test('mainnet gate accepts complete fake evidence and rejects missing recovery evidence', async () => {
  const good = await fixtureJson('mainnet-evidence.example.json');
  assert.equal(verifyMainnetEvidence(good).ok, true);
  const bad = structuredClone(good) as { pausedTimeoutVoid: { permissionlessRecovery: boolean } };
  bad.pausedTimeoutVoid.permissionlessRecovery = false;
  assert.throws(
    () => verifyMainnetEvidence(bad),
    (error: unknown) => error instanceof EscrowControlError && error.exitCode === EXIT.gate,
  );
});

test('mainnet gate rejects drift and insufficient distinct soak days', async () => {
  const drift = await fixtureJson('mainnet-evidence.example.json') as { soakSamples: Array<{ capturedAt: string; driftAtomic: string }> };
  drift.soakSamples[3]!.driftAtomic = '1';
  assert.throws(() => verifyMainnetEvidence(drift), /accounting drift/);
  const short = await fixtureJson('mainnet-evidence.example.json') as { soakSamples: Array<{ capturedAt: string }> };
  short.soakSamples.forEach((sample) => { sample.capturedAt = '2026-07-01T12:00:00Z'; });
  assert.throws(() => verifyMainnetEvidence(short), /seven distinct UTC days/);
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
