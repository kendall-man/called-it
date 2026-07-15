import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVNET_ESCROW_PROGRAM_ID, deriveOracleSetPda } from '@calledit/escrow-sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { OracleSignerEnv } from './env.js';
import { OracleSignatureJournal } from './journal.js';
import {
  createOracleReadinessProbe,
  type OracleReadinessAccount,
  type OracleReadinessChainReader,
  type OracleReadinessReason,
} from './readiness.js';
import { createOracleSignerServer } from './server.js';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const servers: Array<ReturnType<typeof createOracleSignerServer>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function env(
  signer = Keypair.generate(),
  program = new PublicKey(DEVNET_ESCROW_PROGRAM_ID),
  upgradeAuthority = Keypair.generate().publicKey,
): OracleSignerEnv {
  return {
    PORT: 8080,
    ORACLE_SIGNER_NETWORK: 'devnet',
    ORACLE_SIGNER_ALLOW_MAINNET: 'false',
    ORACLE_SIGNER_BEARER_TOKEN: 't'.repeat(32),
    ORACLE_SIGNER_JOURNAL_PATH: '/unused/oracle-signatures.jsonl',
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    ESCROW_PROGRAM_ID: program.toBase58(),
    ESCROW_UPGRADE_AUTHORITY: upgradeAuthority.toBase58(),
    ESCROW_GENESIS_HASH: GENESIS,
    ESCROW_ORACLE_SET_EPOCH: 9n,
    TXLINE_API_BASE: 'https://txline.example',
    TXLINE_GUEST_JWT: 'guest',
    TXLINE_API_TOKEN: 'token',
    ORACLE_SIGNER_CLOCK_SKEW_SECONDS: 30,
    signer,
  };
}

function u64(value: bigint): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(value);
  return result;
}

function oracleSetData(epoch: bigint, signers: readonly PublicKey[], activation = 1n, retirement: bigint | null = null): Buffer {
  const discriminator = createHash('sha256').update('account:OracleSet').digest().subarray(0, 8);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signers.length);
  return Buffer.concat([
    discriminator,
    Buffer.from([1, 1]),
    u64(epoch),
    length,
    ...signers.map((signer) => signer.toBuffer()),
    Buffer.from([2]),
    u64(activation),
    Buffer.from([retirement === null ? 0 : 1]),
    ...(retirement === null ? [] : [u64(retirement)]),
  ]);
}

interface HealthyFixture {
  readonly env: OracleSignerEnv;
  readonly chain: OracleReadinessChainReader;
  readonly accounts: Map<string, OracleReadinessAccount>;
  readonly program: PublicKey;
  readonly programData: PublicKey;
  readonly upgradeAuthority: PublicKey;
  readonly oracleSet: PublicKey;
}

function healthyFixture(): HealthyFixture {
  const signer = Keypair.generate();
  const program = new PublicKey(DEVNET_ESCROW_PROGRAM_ID);
  const upgradeAuthority = Keypair.generate().publicKey;
  const configuration = env(signer, program, upgradeAuthority);
  const programData = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
  const oracleSet = deriveOracleSetPda(program, configuration.ESCROW_ORACLE_SET_EPOCH).publicKey;
  const programBytes = Buffer.alloc(36);
  programBytes.writeUInt32LE(2, 0);
  programData.toBuffer().copy(programBytes, 4);
  const programDataBytes = Buffer.alloc(45);
  programDataBytes.writeUInt32LE(3, 0);
  programDataBytes[12] = 1;
  upgradeAuthority.toBuffer().copy(programDataBytes, 13);
  const members = [signer.publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  const accounts = new Map<string, OracleReadinessAccount>([
    [program.toBase58(), { data: programBytes, executable: true, owner: LOADER }],
    [programData.toBase58(), { data: programDataBytes, executable: false, owner: LOADER }],
    [oracleSet.toBase58(), { data: oracleSetData(9n, members), executable: false, owner: program }],
  ]);
  return {
    env: configuration,
    accounts,
    program,
    programData,
    upgradeAuthority,
    oracleSet,
    chain: {
      genesisHash: async () => GENESIS,
      finalizedSlot: async () => 100n,
      account: async (address) => accounts.get(address.toBase58()) ?? null,
    },
  };
}

async function reasons(fixture: HealthyFixture): Promise<readonly OracleReadinessReason[]> {
  return createOracleReadinessProbe(
    fixture.env,
    { checkPersistence: async () => undefined },
    fixture.chain,
  ).check();
}

describe('oracle signer readiness', () => {
  it('returns 200 only after the live capability probe succeeds', async () => {
    const fixture = healthyFixture();
    const server = createOracleSignerServer({
      bearerToken: 'not-returned',
      signer: fixture.env.signer,
      verifier: { verify: async () => undefined },
      journal: { record: async () => undefined },
      readiness: createOracleReadinessProbe(
        fixture.env,
        { checkPersistence: async () => undefined },
        fixture.chain,
      ),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server did not bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready',
      signerPubkey: fixture.env.signer.publicKey.toBase58(),
    });
  });

  it('returns stable non-secret reasons and 503 when the probe fails', async () => {
    const signer = Keypair.generate();
    const server = createOracleSignerServer({
      bearerToken: 'not-returned', signer,
      verifier: { verify: async () => undefined },
      journal: { record: async () => undefined },
      readiness: { check: async () => ['journal_unavailable'] },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server did not bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready', reasons: ['journal_unavailable'] });
  });

  it('fails closed when RPC identity cannot be read', async () => {
    const fixture = healthyFixture();
    const chain = { ...fixture.chain, genesisHash: async () => { throw new Error('secret endpoint detail'); } };
    expect(await reasons({ ...fixture, chain })).toEqual(['rpc_unavailable']);
  });

  it('rejects a different cluster genesis', async () => {
    const fixture = healthyFixture();
    const chain = { ...fixture.chain, genesisHash: async () => 'wrong-cluster' };
    expect(await reasons({ ...fixture, chain })).toEqual(['genesis_mismatch']);
  });

  it('binds readiness to the repository-compiled program identity', async () => {
    const wrongProgram = healthyFixture();
    expect(await reasons({
      ...wrongProgram,
      env: { ...wrongProgram.env, ESCROW_PROGRAM_ID: Keypair.generate().publicKey.toBase58() },
    })).toEqual(['program_identity_mismatch']);

    const unavailableMainnet = healthyFixture();
    expect(await reasons({
      ...unavailableMainnet,
      env: {
        ...unavailableMainnet.env,
        ORACLE_SIGNER_NETWORK: 'mainnet-beta',
        ORACLE_SIGNER_ALLOW_MAINNET: 'true',
      },
    })).toEqual(['program_identity_mismatch']);
  });

  it('requires the configured program to exist and be executable', async () => {
    const missing = healthyFixture();
    missing.accounts.delete(missing.program.toBase58());
    expect(await reasons(missing)).toEqual(['program_unavailable']);

    const inert = healthyFixture();
    inert.accounts.set(inert.program.toBase58(), {
      ...inert.accounts.get(inert.program.toBase58())!, executable: false,
    });
    expect(await reasons(inert)).toEqual(['program_not_executable']);
  });

  it('requires upgradeable-loader ownership and the canonical ProgramData link', async () => {
    const wrongLoader = healthyFixture();
    wrongLoader.accounts.set(wrongLoader.program.toBase58(), {
      ...wrongLoader.accounts.get(wrongLoader.program.toBase58())!, owner: Keypair.generate().publicKey,
    });
    expect(await reasons(wrongLoader)).toEqual(['program_loader_mismatch']);

    const wrongLink = healthyFixture();
    const bytes = Buffer.from(wrongLink.accounts.get(wrongLink.program.toBase58())!.data);
    Keypair.generate().publicKey.toBuffer().copy(bytes, 4);
    wrongLink.accounts.set(wrongLink.program.toBase58(), {
      ...wrongLink.accounts.get(wrongLink.program.toBase58())!, data: bytes,
    });
    expect(await reasons(wrongLink)).toEqual(['program_data_mismatch']);
  });

  it('requires canonical ProgramData ownership and the exact pinned upgrade authority', async () => {
    const wrongOwner = healthyFixture();
    wrongOwner.accounts.set(wrongOwner.programData.toBase58(), {
      ...wrongOwner.accounts.get(wrongOwner.programData.toBase58())!, owner: Keypair.generate().publicKey,
    });
    expect(await reasons(wrongOwner)).toEqual(['program_data_mismatch']);

    const immutable = healthyFixture();
    const bytes = Buffer.from(immutable.accounts.get(immutable.programData.toBase58())!.data);
    bytes[12] = 0;
    immutable.accounts.set(immutable.programData.toBase58(), {
      ...immutable.accounts.get(immutable.programData.toBase58())!, data: bytes,
    });
    expect(await reasons(immutable)).toEqual(['program_not_upgradeable']);

    const wrongAuthority = healthyFixture();
    const wrongBytes = Buffer.from(wrongAuthority.accounts.get(wrongAuthority.programData.toBase58())!.data);
    Keypair.generate().publicKey.toBuffer().copy(wrongBytes, 13);
    wrongAuthority.accounts.set(wrongAuthority.programData.toBase58(), {
      ...wrongAuthority.accounts.get(wrongAuthority.programData.toBase58())!, data: wrongBytes,
    });
    expect(await reasons(wrongAuthority)).toEqual(['program_upgrade_authority_mismatch']);
  });

  it('requires the configured oracle-set account to be owned by the program', async () => {
    const missing = healthyFixture();
    missing.accounts.delete(missing.oracleSet.toBase58());
    expect(await reasons(missing)).toEqual(['oracle_set_unavailable']);

    const wrongOwner = healthyFixture();
    wrongOwner.accounts.set(wrongOwner.oracleSet.toBase58(), {
      ...wrongOwner.accounts.get(wrongOwner.oracleSet.toBase58())!, owner: Keypair.generate().publicKey,
    });
    expect(await reasons(wrongOwner)).toEqual(['oracle_set_owner_mismatch']);
  });

  it('requires the exact activated 2-of-3 oracle epoch and keeps retired epochs ready', async () => {
    const wrongEpoch = healthyFixture();
    const members = [wrongEpoch.env.signer.publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    wrongEpoch.accounts.set(wrongEpoch.oracleSet.toBase58(), {
      ...wrongEpoch.accounts.get(wrongEpoch.oracleSet.toBase58())!, data: oracleSetData(10n, members),
    });
    expect(await reasons(wrongEpoch)).toEqual(['oracle_set_epoch_mismatch']);

    const retired = healthyFixture();
    const retiredMembers = [retired.env.signer.publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    retired.accounts.set(retired.oracleSet.toBase58(), {
      ...retired.accounts.get(retired.oracleSet.toBase58())!, data: oracleSetData(9n, retiredMembers, 1n, 100n),
    });
    expect(await reasons(retired)).toEqual([]);

    const pending = healthyFixture();
    const pendingMembers = [pending.env.signer.publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    pending.accounts.set(pending.oracleSet.toBase58(), {
      ...pending.accounts.get(pending.oracleSet.toBase58())!, data: oracleSetData(9n, pendingMembers, 101n),
    });
    expect(await reasons(pending)).toEqual(['oracle_set_inactive']);
  });

  it('requires this signer to be a member of the configured oracle set', async () => {
    const fixture = healthyFixture();
    const strangers = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    fixture.accounts.set(fixture.oracleSet.toBase58(), {
      ...fixture.accounts.get(fixture.oracleSet.toBase58())!, data: oracleSetData(9n, strangers),
    });
    expect(await reasons(fixture)).toEqual(['oracle_signer_not_member']);
  });

  it('reports journal durability failures without leaking their error details', async () => {
    const fixture = healthyFixture();
    const probe = createOracleReadinessProbe(
      fixture.env,
      { checkPersistence: async () => { throw new Error('/private/path: permission denied'); } },
      fixture.chain,
    );
    expect(await probe.check()).toEqual(['journal_unavailable']);
  });

  it('fsyncs and reads back a disposable marker without recording a signing decision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'calledit-oracle-readiness-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'journal.jsonl');
    const journal = await OracleSignatureJournal.open(path);

    await expect(journal.checkPersistence()).resolves.toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe('');
    expect(await readdir(`${path}.decisions`)).toEqual([]);
  });
});
