import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';

import {
  BorshWriter,
  CLASSIC_TOKEN_PROGRAM_ID,
  ESCROW_ACCOUNT_DISCRIMINATORS,
  ESCROW_INSTRUCTION_DISCRIMINATORS,
  deriveClassicAssociatedTokenAddress,
  deriveMarketPda,
  deriveUserPositionPda,
  hashMarketDocumentV1,
  uuidToBytes,
  type MarketDocumentV1,
} from '../../packages/escrow-sdk/src/index.js';
import {
  DEVNET_CANONICAL_USDC_MINT,
  DEVNET_GENESIS_HASH,
  PINNED_ESCROW_PROGRAM_ID,
} from './devnet-bootstrap.js';
import type {
  DevnetRoleCredentials,
  DevnetScenarioContext,
} from './devnet-evidence-runner.js';
import {
  createDevnetScenarioDriver,
  recoverPendingDevnetScenarioMarket,
  type ScenarioMarket,
  type DevnetScenarioAccount,
  type DevnetScenarioBlockhash,
  type DevnetScenarioTransport,
} from './devnet-scenario-driver.js';
import { DEVNET_SCENARIOS } from './evidence.js';
import { UPGRADEABLE_LOADER, findProgramAddress } from './release.js';
import type { EvidenceRpcReader, ReleaseManifest } from './types.js';
import { bigintLe, decodeBase58, encodeBase58 } from './util.js';

type InstructionKind = keyof typeof ESCROW_INSTRUCTION_DISCRIMINATORS;

function roles(configAuthority = Keypair.generate()): DevnetRoleCredentials {
  return {
    configAuthority,
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

function manifest(credentials: DevnetRoleCredentials, configAuthority: Keypair): ReleaseManifest {
  const programId = PINNED_ESCROW_PROGRAM_ID;
  const configPda = findProgramAddress([Buffer.from('config')], programId).address;
  const oracleSet = findProgramAddress([Buffer.from('oracle-set'), bigintLe(1n)], programId).address;
  const programDataAddress = PublicKey.findProgramAddressSync(
    [new PublicKey(programId).toBytes()],
    new PublicKey(UPGRADEABLE_LOADER),
  )[0].toBase58();
  return {
    schemaVersion: 1,
    network: 'devnet',
    clusterGenesisHash: DEVNET_GENESIS_HASH,
    programId,
    upgradeableLoaderProgramId: UPGRADEABLE_LOADER,
    programDataAddress,
    upgradeAuthority: Keypair.generate().publicKey.toBase58(),
    configPda,
    build: {
      schemaVersion: 1,
      sourceCommit: 'a'.repeat(40),
      programId,
      sbfSha256: '1'.repeat(64),
      idlSha256: '2'.repeat(64),
      sourceSha256: '3'.repeat(64),
      lockSha256: '4'.repeat(64),
    },
    config: {
      custodyVersion: 1,
      paused: false,
      configAuthority: configAuthority.publicKey.toBase58(),
      pauseAuthority: credentials.pauseAuthority.publicKey.toBase58(),
      marketCreationAuthority: credentials.marketCreationAuthority.publicKey.toBase58(),
      feedOperatorAuthority: credentials.feedOperatorAuthority.publicKey.toBase58(),
      oracleSet,
      relayerFeePayer: credentials.relayerFeePayer.publicKey.toBase58(),
      residualRecipient: Keypair.generate().publicKey.toBase58(),
      canonicalUsdcMint: DEVNET_CANONICAL_USDC_MINT,
      allowedTokenProgram: CLASSIC_TOKEN_PROGRAM_ID.toBase58(),
      minSolPosition: '1000000',
      maxSolPosition: '50000000',
      minUsdcPosition: '1000000',
      maxUsdcPosition: '25000000',
      maxMarketDurationSeconds: '86400',
      maxResolutionDelaySeconds: '21600',
    },
    oracleSet: {
      address: oracleSet,
      custodyVersion: 1,
      epoch: '1',
      signers: [
        credentials.oracleSigners[0].publicKey.toBase58(),
        credentials.oracleSigners[1].publicKey.toBase58(),
        Keypair.generate().publicKey.toBase58(),
      ],
      threshold: 2,
      activationSlot: '1',
      retirementSlot: null,
    },
  };
}

function discriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

function configData(release: ReleaseManifest, paused: boolean): Uint8Array {
  const config = release.config;
  return Buffer.concat([
    discriminator('ProtocolConfig'),
    Buffer.from([config.custodyVersion, 255, paused ? 1 : 0]),
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

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}

function recoveryMarketData(
  market: ScenarioMarket,
  release: ReleaseManifest,
  owner: PublicKey,
  deadline: bigint,
): Uint8Array {
  const document = market.document;
  return new BorshWriter()
    .bytes(Uint8Array.from(ESCROW_ACCOUNT_DISCRIMINATORS.Market))
    .u8(1, 'version').u8(255, 'bump').bytes(uuidToBytes(document.marketUuid))
    .u64(document.fixtureId, 'fixture').bytes(document.claimSpecificationHash)
    .bytes(document.displayTermsHash).bytes(document.oddsMessageHash).bytes(market.documentHash)
    .i64(document.oddsTimestamp, 'quote').u32(document.probabilityPpm, 'probability')
    .u32(document.ratioMilli, 'ratio').u8(0, 'asset').publicKey(PublicKey.default)
    .u16(document.feeBps, 'fee').u8(1, 'state').bool(document.replayFlag, 'replay')
    .publicKey(release.config.residualRecipient).i64(document.oddsTimestamp, 'created')
    .i64(document.inPlayStartTimestamp, 'in play').u64(document.activationDelaySeconds, 'delay')
    .i64(document.positionCutoff, 'cutoff').i64(deadline, 'deadline')
    .u64(document.oracleSetEpoch, 'oracle').u64(0n, 'event')
    .u64(0n, 'active back').u64(0n, 'active doubt')
    .u64(BigInt(release.config.minSolPosition), 'pending back').u64(0n, 'pending doubt')
    .u64(0n, 'matched back').u64(0n, 'matched doubt').u64(0n, 'forfeited')
    .u64(0n, 'processed').u8(0, 'outcome').bytes(new Uint8Array(32))
    .u64(1n, 'positions').u64(0n, 'claimed positions').publicKey(owner).u8(255, 'vault bump')
    .finish();
}

function recoveryPositionData(market: ScenarioMarket, owner: PublicKey, amount: bigint): Uint8Array {
  return new BorshWriter()
    .bytes(Uint8Array.from(ESCROW_ACCOUNT_DISCRIMINATORS.UserPosition))
    .u8(1, 'version').u8(255, 'bump').publicKey(market.marketPda).publicKey(owner)
    .u8(0, 'side').u64(0n, 'active').u64(amount, 'pending').u64(0n, 'refundable')
    .u64(0n, 'base').bool(false, 'processed').u64(1n, 'nonce').bool(false, 'claimed')
    .u64(amount, 'paid').u64(1n, 'created').u64(1n, 'updated').finish();
}

function recoveryScenarioMarket(release: ReleaseManifest, now: number): ScenarioMarket {
  const document: MarketDocumentV1 = {
    marketUuid: '123e4567-e89b-42d3-a456-426614174000',
    fixtureId: 42n,
    claimSpecificationHash: new Uint8Array(32).fill(1),
    displayTermsHash: new Uint8Array(32).fill(2),
    asset: 'sol',
    probabilityPpm: 500_000,
    ratioMilli: 1_000,
    oddsMessageHash: new Uint8Array(32).fill(3),
    oddsTimestamp: BigInt(now - 1),
    inPlayStartTimestamp: BigInt(now),
    activationDelaySeconds: 150n,
    positionCutoff: BigInt(now + 1),
    resolutionDeadline: BigInt(now + 2),
    feeBps: 0,
    oracleSetEpoch: BigInt(release.oracleSet.epoch),
    replayFlag: false,
  };
  const programId = new PublicKey(release.programId);
  return {
    document,
    documentHash: hashMarketDocumentV1(document),
    marketPda: deriveMarketPda(programId, document.marketUuid).publicKey,
  };
}

const discriminatorKinds = new Map(
  Object.entries(ESCROW_INSTRUCTION_DISCRIMINATORS).map(([kind, bytes]) => [
    Buffer.from(bytes).toString('hex'),
    kind as InstructionKind,
  ]),
);

function escrowKinds(raw: Uint8Array, programId: string): readonly InstructionKind[] {
  const transaction = VersionedTransaction.deserialize(raw);
  const message = transaction.message;
  const result: InstructionKind[] = [];
  for (const instruction of message.compiledInstructions) {
    if (message.staticAccountKeys[instruction.programIdIndex]?.toBase58() !== programId) continue;
    const kind = discriminatorKinds.get(Buffer.from(instruction.data).subarray(0, 8).toString('hex'));
    if (kind !== undefined) result.push(kind);
  }
  return result;
}

interface Broadcast {
  readonly signature: string;
  readonly rawHash: string;
  readonly kinds: readonly InstructionKind[];
  readonly skipPreflight: boolean;
}

class MockTransport implements DevnetScenarioTransport {
  readonly broadcasts: Broadcast[] = [];
  readonly finalized = new Set<string>();
  genesisCalls = 0;
  paused = false;
  unix = 2_000_000_000;
  private blockhashNonce = 0;

  constructor(
    readonly release: ReleaseManifest,
    readonly credentials: DevnetRoleCredentials,
  ) {}

  async genesisHash(): Promise<string> {
    this.genesisCalls += 1;
    return DEVNET_GENESIS_HASH;
  }

  async unixTime(): Promise<number> {
    return this.unix;
  }

  async latestBlockhash(): Promise<DevnetScenarioBlockhash> {
    this.blockhashNonce += 1;
    const seed = Buffer.alloc(32);
    seed.writeUInt32LE(this.blockhashNonce);
    return { blockhash: encodeBase58(seed), lastValidBlockHeight: 10_000 + this.blockhashNonce };
  }

  async account(address: string): Promise<DevnetScenarioAccount | null> {
    if (address === this.release.configPda) {
      return { owner: this.release.programId, data: configData(this.release, this.paused) };
    }
    const mint = new PublicKey(this.release.config.canonicalUsdcMint);
    const expected = deriveClassicAssociatedTokenAddress(this.credentials.usdcUser.publicKey, mint).toBase58();
    if (address === expected) {
      return {
        owner: this.release.config.allowedTokenProgram,
        data: tokenAccount(mint, this.credentials.usdcUser.publicKey, 10_000_000n),
      };
    }
    return null;
  }

  async sendRawTransaction(rawTransaction: Uint8Array, options?: { readonly skipPreflight?: boolean }): Promise<string> {
    const transaction = VersionedTransaction.deserialize(rawTransaction);
    const signatureBytes = transaction.signatures[0];
    assert.ok(signatureBytes !== undefined);
    const signature = encodeBase58(signatureBytes);
    const kinds = escrowKinds(rawTransaction, this.release.programId);
    for (const instruction of transaction.message.compiledInstructions) {
      if (transaction.message.staticAccountKeys[instruction.programIdIndex]?.toBase58() !== this.release.programId) continue;
      const kind = discriminatorKinds.get(Buffer.from(instruction.data).subarray(0, 8).toString('hex'));
      if (kind === 'set_pause') this.paused = Buffer.from(instruction.data)[8] === 1;
    }
    this.broadcasts.push({
      signature,
      rawHash: createHash('sha256').update(rawTransaction).digest('hex'),
      kinds,
      skipPreflight: options?.skipPreflight ?? false,
    });
    return signature;
  }

  async confirmFinalized(input: DevnetScenarioBlockhash & { readonly signature: string }): Promise<void> {
    this.finalized.add(input.signature);
  }

  async isFinalized(signature: string): Promise<boolean> {
    return this.finalized.has(signature);
  }

  async sleep(milliseconds: number): Promise<void> {
    this.unix += Math.max(1, Math.ceil(milliseconds / 1_000));
  }
}

class RecoveryTransport extends MockTransport {
  readonly scenarioMarket: ScenarioMarket;
  readonly owner: PublicKey;
  readonly deadline: bigint;

  constructor(
    release: ReleaseManifest,
    credentials: DevnetRoleCredentials,
    scenarioMarket: ScenarioMarket,
    owner: PublicKey,
  ) {
    super(release, credentials);
    this.scenarioMarket = scenarioMarket;
    this.owner = owner;
    this.deadline = BigInt(this.unix + 2);
  }

  override async account(address: string): Promise<DevnetScenarioAccount | null> {
    if (address === this.scenarioMarket.marketPda.toBase58()) {
      return {
        owner: this.release.programId,
        data: recoveryMarketData(this.scenarioMarket, this.release, this.owner, this.deadline),
      };
    }
    const position = deriveUserPositionPda(
      this.release.programId,
      this.scenarioMarket.marketPda,
      this.owner,
    ).publicKey;
    if (address === position.toBase58()) {
      return {
        owner: this.release.programId,
        data: recoveryPositionData(
          this.scenarioMarket,
          this.owner,
          BigInt(this.release.config.minSolPosition),
        ),
      };
    }
    return super.account(address);
  }
}

function unusedRpc(): EvidenceRpcReader {
  return {
    async genesisHash() { throw new Error('driver must use its transaction transport'); },
    async account() { throw new Error('driver must use its transaction transport'); },
    async finalizedTransaction() { throw new Error('driver must use its transaction transport'); },
  };
}

function context(release: ReleaseManifest, credentials: DevnetRoleCredentials, runId: string): DevnetScenarioContext {
  return {
    manifest: release,
    rpcUrl: 'https://devnet.invalid',
    rpc: unusedRpc(),
    credentials,
    runId,
  };
}

test('dispatches all seven scenarios as signed finalized devnet transactions', async () => {
  const configAuthority = Keypair.generate();
  const credentials = roles(configAuthority);
  const release = manifest(credentials, configAuthority);
  const transport = new MockTransport(release, credentials);
  const driver = await createDevnetScenarioDriver({
    transportFactory: () => transport,
  });
  const execution = context(release, credentials, 'all-scenarios');
  const returned: string[] = [];

  for (const id of DEVNET_SCENARIOS) {
    returned.push((await driver.execute(id, execution)).transactionSignature);
  }
  await driver.restoreBaseline(execution);

  assert.equal(new Set(returned).size, DEVNET_SCENARIOS.length);
  assert.ok(returned.every((signature) => transport.finalized.has(signature)));
  assert.equal(transport.paused, false);
  assert.ok(transport.genesisCalls > transport.broadcasts.length);

  const kinds = transport.broadcasts.flatMap((broadcast) => broadcast.kinds);
  assert.equal(kinds.filter((kind) => kind === 'initialize_market').length, DEVNET_SCENARIOS.length);
  assert.equal(kinds.filter((kind) => kind === 'place_position').length, DEVNET_SCENARIOS.length + 1);
  assert.equal(kinds.filter((kind) => kind === 'settle_market').length, 6);
  assert.equal(kinds.filter((kind) => kind === 'calculate_position_entitlement').length, 6);
  assert.equal(kinds.filter((kind) => kind === 'claim_position').length, 1);
  assert.equal(kinds.filter((kind) => kind === 'claim_position_for').length, 6);
  assert.equal(kinds.filter((kind) => kind === 'timeout_void').length, 1);
  assert.equal(kinds.filter((kind) => kind === 'set_pause').length, 2);

  const byRawHash = new Map<string, Broadcast[]>();
  for (const broadcast of transport.broadcasts) {
    const group = byRawHash.get(broadcast.rawHash) ?? [];
    group.push(broadcast);
    byRawHash.set(broadcast.rawHash, group);
  }
  const retried = [...byRawHash.values()].find((group) => group.length === 2);
  assert.ok(retried !== undefined);
  assert.equal(retried[0]?.signature, retried[1]?.signature);
  assert.equal(retried[1]?.skipPreflight, true);
});

test('restoreBaseline unpauses using the manifest config authority', async () => {
  const configAuthority = Keypair.generate();
  const credentials = roles(configAuthority);
  const release = manifest(credentials, configAuthority);
  const transport = new MockTransport(release, credentials);
  transport.paused = true;
  const driver = await createDevnetScenarioDriver({ transportFactory: () => transport });

  await driver.restoreBaseline(context(release, credentials, 'restore-only'));

  assert.equal(transport.paused, false);
  assert.deepEqual(transport.broadcasts.flatMap((broadcast) => broadcast.kinds), ['set_pause']);
});

test('refuses mainnet before creating a transport or constructing a transaction', async () => {
  const configAuthority = Keypair.generate();
  const credentials = roles(configAuthority);
  const release = { ...manifest(credentials, configAuthority), network: 'mainnet-beta' as const };
  let transportFactoryCalls = 0;
  const driver = await createDevnetScenarioDriver({
    transportFactory: () => {
      transportFactoryCalls += 1;
      return new MockTransport(release, credentials);
    },
  });

  await assert.rejects(
    driver.execute('real-sol-position', context(release, credentials, 'mainnet-refusal')),
    /refuses every non-devnet manifest/,
  );
  assert.equal(transportFactoryCalls, 0);
});

test('recovers a placed open-market position through finalized timeout void and claim', async () => {
  const configAuthority = Keypair.generate();
  const credentials = roles(configAuthority);
  const release = manifest(credentials, configAuthority);
  const scenarioMarket = recoveryScenarioMarket(release, 2_000_000_000);
  const transport = new RecoveryTransport(
    release,
    credentials,
    scenarioMarket,
    credentials.solUser.publicKey,
  );

  await recoverPendingDevnetScenarioMarket({
    context: context(release, credentials, 'recovery'),
    transport,
    pending: { market: scenarioMarket, owner: credentials.solUser },
  });

  assert.ok(BigInt(transport.unix) > transport.deadline);
  assert.deepEqual(
    transport.broadcasts.flatMap((broadcast) => broadcast.kinds),
    ['timeout_void', 'claim_position_for'],
  );
  assert.ok(transport.broadcasts.every((broadcast) => transport.finalized.has(broadcast.signature)));
});
