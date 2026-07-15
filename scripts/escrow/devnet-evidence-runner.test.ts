import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Keypair, PublicKey } from '@solana/web3.js';

import { DEVNET_SCENARIOS, parseDevnetE2eReport } from './evidence.js';
import {
  DEVNET_E2E_ROLE_ENV,
  DevnetEvidenceRunnerError,
  loadDevnetRoleCredentials,
  runDevnetEvidence,
  type DevnetRoleCredentials,
  type DevnetScenarioDriver,
} from './devnet-evidence-runner.js';
import {
  DEVNET_CANONICAL_USDC_MINT,
  DEVNET_GENESIS_HASH,
  PINNED_ESCROW_PROGRAM_ID,
} from './devnet-bootstrap.js';
import { CLASSIC_TOKEN_PROGRAM, UPGRADEABLE_LOADER, findProgramAddress } from './release.js';
import type { EvidenceRpcReader, ReleaseManifest, RpcAccount } from './types.js';
import { bigintLe, decodeBase58, encodeBase58, sha256 } from './util.js';

function credentials(): DevnetRoleCredentials {
  return {
    marketCreationAuthority: Keypair.generate(),
    feedOperatorAuthority: Keypair.generate(),
    pauseAuthority: Keypair.generate(),
    relayerFeePayer: Keypair.generate(),
    oracleSigners: [Keypair.generate(), Keypair.generate()],
    solUser: Keypair.generate(),
    usdcUser: Keypair.generate(),
    directClaimUser: Keypair.generate(),
  };
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function discriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

function minimalElf(): Buffer {
  const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(elf);
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(64, 58);
  return elf;
}

function configData(release: ReleaseManifest, bump: number): Buffer {
  const config = release.config;
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
    decodeBase58(release.clusterGenesisHash),
    decodeBase58(config.canonicalUsdcMint),
    decodeBase58(config.allowedTokenProgram),
    bigintLe(BigInt(config.maxSolPosition)),
    bigintLe(BigInt(config.maxUsdcPosition)),
    bigintLe(BigInt(config.minSolPosition)),
    bigintLe(BigInt(config.minUsdcPosition)),
    bigintLe(BigInt(config.maxMarketDurationSeconds)),
    bigintLe(BigInt(config.maxResolutionDelaySeconds)),
  ]);
}

function oracleData(release: ReleaseManifest, bump: number): Buffer {
  const oracle = release.oracleSet;
  return Buffer.concat([
    discriminator('OracleSet'),
    Buffer.from([oracle.custodyVersion, bump]),
    bigintLe(BigInt(oracle.epoch)),
    u32(oracle.signers.length),
    ...oracle.signers.map(decodeBase58),
    Buffer.from([oracle.threshold]),
    bigintLe(BigInt(oracle.activationSlot)),
    Buffer.from([0]),
    Buffer.alloc(8),
  ]);
}

interface ReleaseFixture {
  readonly manifest: ReleaseManifest;
  readonly accounts: ReadonlyMap<string, RpcAccount>;
}

function releaseFixture(roles: DevnetRoleCredentials, network: ReleaseManifest['network'] = 'devnet'): ReleaseFixture {
  const key = () => Keypair.generate().publicKey.toBase58();
  const thirdOracle = Keypair.generate().publicKey.toBase58();
  const programId = PINNED_ESCROW_PROGRAM_ID;
  const config = findProgramAddress([Buffer.from('config')], programId);
  const oracle = findProgramAddress([Buffer.from('oracle-set'), bigintLe(1n)], programId);
  const programDataAddress = PublicKey.findProgramAddressSync(
    [new PublicKey(programId).toBytes()],
    new PublicKey(UPGRADEABLE_LOADER),
  )[0].toBase58();
  const sbf = minimalElf();
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    network,
    clusterGenesisHash: network === 'devnet'
      ? DEVNET_GENESIS_HASH
      : '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    programId,
    upgradeableLoaderProgramId: UPGRADEABLE_LOADER,
    programDataAddress,
    upgradeAuthority: key(),
    configPda: config.address,
    build: {
      schemaVersion: 1,
      sourceCommit: 'a'.repeat(40),
      programId,
      sbfSha256: sha256(sbf),
      idlSha256: '2'.repeat(64),
      sourceSha256: '3'.repeat(64),
      lockSha256: '4'.repeat(64),
    },
    config: {
      custodyVersion: 1,
      paused: false,
      configAuthority: key(),
      pauseAuthority: roles.pauseAuthority.publicKey.toBase58(),
      marketCreationAuthority: roles.marketCreationAuthority.publicKey.toBase58(),
      feedOperatorAuthority: roles.feedOperatorAuthority.publicKey.toBase58(),
      oracleSet: oracle.address,
      relayerFeePayer: roles.relayerFeePayer.publicKey.toBase58(),
      residualRecipient: key(),
      canonicalUsdcMint: DEVNET_CANONICAL_USDC_MINT,
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
      signers: [
        roles.oracleSigners[0].publicKey.toBase58(),
        roles.oracleSigners[1].publicKey.toBase58(),
        thirdOracle,
      ],
      threshold: 2,
      activationSlot: '10',
      retirementSlot: null,
    },
  };
  const program = Buffer.alloc(36);
  program.writeUInt32LE(2, 0);
  decodeBase58(programDataAddress).copy(program, 4);
  const programData = Buffer.alloc(45 + sbf.length + 16);
  programData.writeUInt32LE(3, 0);
  programData[12] = 1;
  decodeBase58(manifest.upgradeAuthority).copy(programData, 13);
  sbf.copy(programData, 45);
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  const account = (owner: string, data: Buffer, executable = false): RpcAccount => ({ owner, data, executable, lamports: 1 });
  return {
    manifest,
    accounts: new Map([
      [programId, account(UPGRADEABLE_LOADER, program, true)],
      [programDataAddress, account(UPGRADEABLE_LOADER, programData)],
      [config.address, account(programId, configData(manifest, config.bump))],
      [oracle.address, account(programId, oracleData(manifest, oracle.bump))],
      [DEVNET_CANONICAL_USDC_MINT, account(CLASSIC_TOKEN_PROGRAM, mint)],
    ]),
  };
}

function rpcFor(fixture: ReleaseFixture, blockTime: number, transactionProgram = fixture.manifest.programId): EvidenceRpcReader {
  return {
    async genesisHash() { return DEVNET_GENESIS_HASH; },
    async account(address: string) {
      const found = fixture.accounts.get(address);
      if (found === undefined) throw new Error('missing fixture account');
      return found;
    },
    async finalizedTransaction(signature: string) {
      return { slot: 100, blockTime, accountKeys: [transactionProgram, signature] };
    },
  };
}

test('refuses mainnet before RPC or driver code can run', async () => {
  const roles = credentials();
  const fixture = releaseFixture(roles, 'mainnet-beta');
  let rpcCalls = 0;
  const rpc: EvidenceRpcReader = {
    async genesisHash() { rpcCalls += 1; return DEVNET_GENESIS_HASH; },
    async account() { rpcCalls += 1; throw new Error('must not read RPC'); },
    async finalizedTransaction() { rpcCalls += 1; throw new Error('must not read RPC'); },
  };
  await assert.rejects(
    runDevnetEvidence({
      mode: 'dry-run',
      manifest: fixture.manifest,
      rpcUrl: 'https://rpc.invalid',
      rpc,
      credentials: roles,
    }),
    /only Solana devnet/,
  );
  assert.equal(rpcCalls, 0);
});

test('dry-run performs preflight without loading or invoking a transaction driver', async () => {
  const roles = credentials();
  const fixture = releaseFixture(roles);
  const release = fixture.manifest;
  const result = await runDevnetEvidence({
    mode: 'dry-run',
    manifest: release,
    rpcUrl: 'https://private-rpc.invalid/?api-key=sentinel-rpc-secret',
    rpc: rpcFor(fixture, 0),
    credentials: roles,
    runId: 'dry-run-id',
    now: () => new Date('2026-07-15T10:00:00Z'),
  });

  assert.equal(result.kind, 'devnet-e2e-preflight');
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(result.scenarios, DEVNET_SCENARIOS);
  assert.doesNotMatch(JSON.stringify(result), /sentinel-rpc-secret/);
});

test('preflight rejects a malformed deployed canonical mint', async () => {
  const roles = credentials();
  const fixture = releaseFixture(roles);
  const accounts = new Map(fixture.accounts);
  const mint = accounts.get(DEVNET_CANONICAL_USDC_MINT)!;
  const malformedMint = Buffer.from(mint.data);
  malformedMint[44] = 9;
  accounts.set(DEVNET_CANONICAL_USDC_MINT, { ...mint, data: malformedMint });

  await assert.rejects(runDevnetEvidence({
    mode: 'dry-run',
    manifest: fixture.manifest,
    rpcUrl: 'https://rpc.invalid',
    rpc: rpcFor({ ...fixture, accounts }, 0),
    credentials: roles,
  }), /USDC mint layout is invalid/);
});

test('execute verifies finalized program transactions and emits the required report structure', async () => {
  const roles = credentials();
  const fixture = releaseFixture(roles);
  const release = fixture.manifest;
  const signatures = new Map(DEVNET_SCENARIOS.map((id, index) => [
    id,
    encodeBase58(Buffer.alloc(64, index + 1)),
  ]));
  const calls: string[] = [];
  let cleanupCalls = 0;
  const driver: DevnetScenarioDriver = {
    async execute(id) {
      calls.push(id);
      return { transactionSignature: signatures.get(id)! };
    },
    async restoreBaseline() { cleanupCalls += 1; },
  };

  const result = await runDevnetEvidence({
    mode: 'execute',
    manifest: release,
    rpcUrl: 'https://rpc.invalid',
    rpc: rpcFor(fixture, Date.parse('2026-07-15T10:00:00Z') / 1_000),
    credentials: roles,
    driver,
    runId: 'live-run-id',
    now: () => new Date('2026-07-15T10:00:00Z'),
  });

  assert.equal(result.kind, 'devnet-e2e-report');
  assert.deepEqual(calls, DEVNET_SCENARIOS);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(parseDevnetE2eReport(result), result);
});

test('execute restores baseline and rejects a finalized transaction that omits the escrow program', async () => {
  const roles = credentials();
  const fixture = releaseFixture(roles);
  const release = fixture.manifest;
  let cleanupCalls = 0;
  const driver: DevnetScenarioDriver = {
    async execute(_id, context) {
      return { transactionSignature: encodeBase58(Buffer.alloc(64, context.runId.length)) };
    },
    async restoreBaseline() { cleanupCalls += 1; },
  };
  const rpc = rpcFor(
    fixture,
    Date.parse('2026-07-15T10:00:00Z') / 1_000,
    Keypair.generate().publicKey.toBase58(),
  );

  await assert.rejects(runDevnetEvidence({
    mode: 'execute', manifest: release, rpcUrl: 'https://rpc.invalid', rpc, credentials: roles, driver,
    runId: 'failed-live-run',
    now: () => new Date('2026-07-15T10:00:00Z'),
  }), /does not invoke the manifest program/);
  assert.equal(cleanupCalls, 1);
});

test('driver failures are redacted and still restore the manifest baseline', async () => {
  const roles = credentials();
  const fixture = releaseFixture(roles);
  let cleanupCalls = 0;
  const driver: DevnetScenarioDriver = {
    async execute() { throw new Error('sentinel-private-key-material'); },
    async restoreBaseline() { cleanupCalls += 1; },
  };
  let message = '';
  await assert.rejects(runDevnetEvidence({
    mode: 'execute',
    manifest: fixture.manifest,
    rpcUrl: 'https://rpc.invalid',
    rpc: rpcFor(fixture, Date.parse('2026-07-15T10:00:00Z') / 1_000),
    credentials: roles,
    driver,
    runId: 'redaction-run',
    now: () => new Date('2026-07-15T10:00:00Z'),
  }), (error: unknown) => {
    assert(error instanceof Error);
    message = error.message;
    return true;
  });
  assert.equal(cleanupCalls, 1);
  assert.doesNotMatch(message, /sentinel-private-key-material/);
});

test('loads role keypairs only from secure env-supplied files without exposing secret material', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'calledit-devnet-runner-'));
  const source = credentials();
  const entries: readonly [keyof typeof DEVNET_E2E_ROLE_ENV, Keypair][] = [
    ['marketCreationAuthority', source.marketCreationAuthority],
    ['feedOperatorAuthority', source.feedOperatorAuthority],
    ['pauseAuthority', source.pauseAuthority],
    ['relayerFeePayer', source.relayerFeePayer],
    ['oracleSigner1', source.oracleSigners[0]],
    ['oracleSigner2', source.oracleSigners[1]],
    ['solUser', source.solUser],
    ['usdcUser', source.usdcUser],
    ['directClaimUser', source.directClaimUser],
  ];
  const environment: NodeJS.ProcessEnv = {};
  try {
    await Promise.all(entries.map(async ([role, keypair], index) => {
      const path = join(directory, `sentinel-secret-path-${index}.json`);
      await writeFile(path, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
      environment[DEVNET_E2E_ROLE_ENV[role]] = path;
    }));
    const loaded = await loadDevnetRoleCredentials(environment);
    assert.equal(loaded.relayerFeePayer.publicKey.toBase58(), source.relayerFeePayer.publicKey.toBase58());
    assert.doesNotMatch(JSON.stringify(loaded), /secretKey|sentinel-secret-path/);

    const missing = { ...environment };
    const secretPath = missing[DEVNET_E2E_ROLE_ENV.solUser]!;
    delete missing[DEVNET_E2E_ROLE_ENV.solUser];
    await assert.rejects(loadDevnetRoleCredentials(missing), (error: unknown) => {
      assert(error instanceof DevnetEvidenceRunnerError);
      assert.doesNotMatch(error.message, new RegExp(secretPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
