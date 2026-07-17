import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type AccountInfo,
  type TransactionInstruction,
} from '@solana/web3.js';

import {
  CLASSIC_TOKEN_PROGRAM_ID,
  DEVNET_ESCROW_PROGRAM_ID,
  deriveOracleSetPda,
  deriveProtocolConfigPda,
  materializeInstruction,
} from '../../packages/escrow-sdk/src/index.js';
import {
  UPGRADEABLE_LOADER,
  decodeClassicMint,
  decodeOracleSet,
  decodeProgramDataAddress,
  decodeProtocolConfig,
  decodeUpgradeAuthority,
} from './release.js';
import type { OracleSetAccount, ProtocolConfigAccount, RpcAccount } from './types.js';
import { decodeBase58, stableJson } from './util.js';

export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const DEVNET_CANONICAL_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const PINNED_ESCROW_PROGRAM_ID = DEVNET_ESCROW_PROGRAM_ID;
export const ORACLE_SET_EPOCH = 1n;
export const ORACLE_THRESHOLD = 2;

export const DEVNET_LIMITS = Object.freeze({
  minimumSolPosition: 1_000_000n,
  maximumSolPosition: 50_000_000n,
  minimumUsdcPosition: 1_000_000n,
  maximumUsdcPosition: 25_000_000n,
  maximumMarketDurationSeconds: 86_400n,
  maximumResolutionDelaySeconds: 21_600n,
});

const UPGRADEABLE_LOADER_ID = new PublicKey(UPGRADEABLE_LOADER);
const ZERO_ADDRESS = PublicKey.default.toBase58();
const EXPECTED_VERSION = 1;

export class DevnetBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevnetBootstrapError';
  }
}

export interface DevnetRoleKeypairPaths {
  readonly upgradeAuthority: string;
  readonly transactionPayer: string;
  readonly configAuthority: string;
  readonly pauseAuthority: string;
  readonly marketCreationAuthority: string;
  readonly feedOperatorAuthority: string;
  readonly relayerFeePayer: string;
  readonly residualRecipient: string;
  readonly oracleSigners: readonly [string, string, string];
}

export interface DevnetBootstrapOptions {
  readonly rpcUrl: string;
  readonly solanaBinary: string;
  readonly programKeypairPath: string;
  readonly programSoPath: string;
  readonly roles: DevnetRoleKeypairPaths;
  readonly oracleActivationSlot: bigint;
  readonly manifestOutputPath: string;
  readonly envOutputPath: string;
  readonly execute: boolean;
}

interface LoadedIdentities {
  readonly program: Keypair;
  readonly upgradeAuthority: Keypair;
  readonly transactionPayer: Keypair;
  readonly configAuthority: Keypair;
  readonly pauseAuthority: Keypair;
  readonly marketCreationAuthority: Keypair;
  readonly feedOperatorAuthority: Keypair;
  readonly relayerFeePayer: Keypair;
  readonly residualRecipient: Keypair;
  readonly oracleSigners: readonly [Keypair, Keypair, Keypair];
}

export interface DevnetPublicDeployment {
  readonly network: 'devnet';
  readonly clusterGenesisHash: string;
  readonly programId: string;
  readonly programDataAddress: string;
  readonly programSha256: string;
  readonly configPda: string;
  readonly oracleSetPda: string;
  readonly oracleSetEpoch: string;
  readonly canonicalUsdcMint: string;
  readonly classicTokenProgramId: string;
  readonly limits: {
    readonly minimumSolPosition: string;
    readonly maximumSolPosition: string;
    readonly minimumUsdcPosition: string;
    readonly maximumUsdcPosition: string;
    readonly maximumMarketDurationSeconds: string;
    readonly maximumResolutionDelaySeconds: string;
  };
  readonly authorities: {
    readonly upgrade: string;
    readonly config: string;
    readonly pause: string;
    readonly marketCreation: string;
    readonly feedOperator: string;
    readonly relayerFeePayer: string;
    readonly residualRecipient: string;
  };
  readonly oracleSet: {
    readonly signers: readonly [string, string, string];
    readonly threshold: 2;
    readonly activationSlot: string;
    readonly retirementSlot: null;
  };
  readonly custodyModeAction: 'unchanged';
}

export interface SanitizedArtifacts {
  readonly manifest: string;
  readonly env: string;
}

export interface DevnetBootstrapResult {
  readonly mode: 'dry-run' | 'execute';
  readonly network: 'devnet';
  readonly programId: string;
  readonly configPda: string;
  readonly oracleSetPda: string;
  readonly actions: readonly string[];
  readonly verified: boolean;
  readonly outputsWritten: boolean;
}

type ProgramAction = 'none' | 'deploy' | 'upgrade';

interface ProtocolAssessment {
  readonly initializeConfig: boolean;
  readonly initializeOracleSet: boolean;
}

interface BootstrapAssessment extends ProtocolAssessment {
  readonly programAction: ProgramAction;
}

function fail(message: string): never {
  throw new DevnetBootstrapError(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) fail(`${label} mismatch`);
}

export function assertExactDevnetGenesis(actual: string): void {
  if (actual !== DEVNET_GENESIS_HASH) {
    fail('RPC genesis hash is not the exact Solana devnet genesis hash; refusing all actions');
  }
}

export function assertPinnedProgramIdentity(programPublicKey: PublicKey): void {
  if (programPublicKey.toBase58() !== PINNED_ESCROW_PROGRAM_ID) {
    fail('program keypair does not derive the repository-pinned escrow program ID');
  }
}

function rpcAccount(info: AccountInfo<Buffer>): RpcAccount {
  return {
    owner: info.owner.toBase58(),
    executable: info.executable,
    lamports: info.lamports,
    data: Buffer.from(info.data),
  };
}

async function readKeypair(path: string, label: string): Promise<Keypair> {
  const file = await lstat(path).catch(() => null);
  if (file === null || !file.isFile()) fail(`${label} keypair must be an explicit regular file`);
  if ((file.mode & 0o077) !== 0) fail(`${label} keypair must not be readable or writable by group/other users`);
  const raw = await readFile(path, 'utf8').catch(() => fail(`${label} keypair could not be read`));
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    fail(`${label} keypair is not valid JSON`);
  }
  if (!Array.isArray(value) || value.length !== 64 || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    fail(`${label} keypair must be a 64-byte Solana JSON keypair`);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(value as number[]));
  } catch {
    fail(`${label} keypair is invalid`);
  }
}

async function readProgramArtifact(path: string): Promise<{ readonly bytes: Buffer; readonly sha256: string }> {
  const file = await lstat(path).catch(() => null);
  if (file === null || !file.isFile()) fail('program SBF must be an explicit regular file');
  const bytes = await readFile(path).catch(() => fail('program SBF could not be read'));
  if (bytes.length === 0) fail('program SBF must not be empty');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function loadIdentities(options: DevnetBootstrapOptions): Promise<LoadedIdentities> {
  const values = await Promise.all([
    readKeypair(options.programKeypairPath, 'program'),
    readKeypair(options.roles.upgradeAuthority, 'upgrade authority'),
    readKeypair(options.roles.transactionPayer, 'transaction payer'),
    readKeypair(options.roles.configAuthority, 'config authority'),
    readKeypair(options.roles.pauseAuthority, 'pause authority'),
    readKeypair(options.roles.marketCreationAuthority, 'market-creation authority'),
    readKeypair(options.roles.feedOperatorAuthority, 'feed-operator authority'),
    readKeypair(options.roles.relayerFeePayer, 'relayer fee payer'),
    readKeypair(options.roles.residualRecipient, 'residual recipient'),
    readKeypair(options.roles.oracleSigners[0], 'oracle signer 1'),
    readKeypair(options.roles.oracleSigners[1], 'oracle signer 2'),
    readKeypair(options.roles.oracleSigners[2], 'oracle signer 3'),
  ]);
  const [
    program,
    upgradeAuthority,
    transactionPayer,
    configAuthority,
    pauseAuthority,
    marketCreationAuthority,
    feedOperatorAuthority,
    relayerFeePayer,
    residualRecipient,
    oracle1,
    oracle2,
    oracle3,
  ] = values as [Keypair, Keypair, Keypair, Keypair, Keypair, Keypair, Keypair, Keypair, Keypair, Keypair, Keypair, Keypair];
  assertPinnedProgramIdentity(program.publicKey);
  const roleKeys = [
    upgradeAuthority,
    transactionPayer,
    configAuthority,
    pauseAuthority,
    marketCreationAuthority,
    feedOperatorAuthority,
    relayerFeePayer,
    residualRecipient,
    oracle1,
    oracle2,
    oracle3,
  ].map((keypair) => keypair.publicKey.toBase58());
  if (new Set(roleKeys).size !== roleKeys.length) fail('every provided devnet role keypair must have a distinct public key');
  return {
    program,
    upgradeAuthority,
    transactionPayer,
    configAuthority,
    pauseAuthority,
    marketCreationAuthority,
    feedOperatorAuthority,
    relayerFeePayer,
    residualRecipient,
    oracleSigners: [oracle1, oracle2, oracle3],
  };
}

function programDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], UPGRADEABLE_LOADER_ID)[0];
}

async function assertDevnet(connection: Connection): Promise<void> {
  assertExactDevnetGenesis(await connection.getGenesisHash());
}

async function verifyCanonicalUsdc(connection: Connection): Promise<void> {
  const mint = await connection.getAccountInfo(new PublicKey(DEVNET_CANONICAL_USDC_MINT), 'finalized');
  if (mint === null) fail('canonical devnet USDC mint account is missing');
  assertEqual(mint.owner.toBase58(), CLASSIC_TOKEN_PROGRAM_ID.toBase58(), 'canonical devnet USDC owner');
  assertEqual(mint.executable, false, 'canonical devnet USDC executable flag');
  const decoded = decodeClassicMint(rpcAccount(mint));
  assertEqual(decoded.decimals, 6, 'canonical devnet USDC decimals');
  assertEqual(decoded.initialized, true, 'canonical devnet USDC initialization');
}

function artifactMatchesProgramData(programData: Buffer, artifact: Buffer): boolean {
  if (programData.length < 45 + artifact.length) return false;
  const deployed = programData.subarray(45);
  return deployed.subarray(0, artifact.length).equals(artifact)
    && !deployed.subarray(artifact.length).some((byte) => byte !== 0);
}

async function inspectProgram(
  connection: Connection,
  identities: LoadedIdentities,
  artifact: Buffer,
): Promise<ProgramAction> {
  const programId = identities.program.publicKey;
  const program = await connection.getAccountInfo(programId, 'finalized');
  if (program === null) return 'deploy';
  assertEqual(program.owner.toBase58(), UPGRADEABLE_LOADER, 'program account owner');
  assertEqual(program.executable, true, 'program executable flag');
  const expectedProgramData = programDataAddress(programId);
  assertEqual(decodeProgramDataAddress(rpcAccount(program)), expectedProgramData.toBase58(), 'program-data address');
  const data = await connection.getAccountInfo(expectedProgramData, 'finalized');
  if (data === null) fail('program-data account is missing');
  assertEqual(data.owner.toBase58(), UPGRADEABLE_LOADER, 'program-data owner');
  assertEqual(data.executable, false, 'program-data executable flag');
  assertEqual(
    decodeUpgradeAuthority(rpcAccount(data)),
    identities.upgradeAuthority.publicKey.toBase58(),
    'program upgrade authority',
  );
  return artifactMatchesProgramData(Buffer.from(data.data), artifact) ? 'none' : 'upgrade';
}

function expectedConfig(identities: LoadedIdentities, oracleSet: string): ProtocolConfigAccount {
  const config = deriveProtocolConfigPda(identities.program.publicKey);
  return {
    version: EXPECTED_VERSION,
    bump: config.bump,
    paused: false,
    configAuthority: identities.configAuthority.publicKey.toBase58(),
    pauseAuthority: identities.pauseAuthority.publicKey.toBase58(),
    marketCreationAuthority: identities.marketCreationAuthority.publicKey.toBase58(),
    feedOperatorAuthority: identities.feedOperatorAuthority.publicKey.toBase58(),
    oracleSet,
    relayerFeePayer: identities.relayerFeePayer.publicKey.toBase58(),
    residualRecipient: identities.residualRecipient.publicKey.toBase58(),
    clusterGenesisHash: DEVNET_GENESIS_HASH,
    canonicalUsdcMint: DEVNET_CANONICAL_USDC_MINT,
    allowedTokenProgram: CLASSIC_TOKEN_PROGRAM_ID.toBase58(),
    maxSolPosition: DEVNET_LIMITS.maximumSolPosition.toString(),
    maxUsdcPosition: DEVNET_LIMITS.maximumUsdcPosition.toString(),
    minSolPosition: DEVNET_LIMITS.minimumSolPosition.toString(),
    minUsdcPosition: DEVNET_LIMITS.minimumUsdcPosition.toString(),
    maxMarketDurationSeconds: DEVNET_LIMITS.maximumMarketDurationSeconds.toString(),
    maxResolutionDelaySeconds: DEVNET_LIMITS.maximumResolutionDelaySeconds.toString(),
  };
}

function expectedOracle(identities: LoadedIdentities, activationSlot: bigint): OracleSetAccount {
  const oracle = deriveOracleSetPda(identities.program.publicKey, ORACLE_SET_EPOCH);
  return {
    version: EXPECTED_VERSION,
    bump: oracle.bump,
    epoch: ORACLE_SET_EPOCH.toString(),
    signers: identities.oracleSigners.map((signer) => signer.publicKey.toBase58()),
    threshold: ORACLE_THRESHOLD,
    activationSlot: activationSlot.toString(),
    retirementSlot: null,
  };
}

function assertObjectFields(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
  label: string,
): void {
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[field];
    if (Array.isArray(expectedValue)) {
      if (!Array.isArray(actualValue) || actualValue.length !== expectedValue.length
        || actualValue.some((entry, index) => entry !== expectedValue[index])) {
        fail(`${label}.${field} mismatch`);
      }
    } else if (actualValue !== expectedValue) {
      fail(`${label}.${field} mismatch`);
    }
  }
}

export function verifyDecodedProtocolState(
  actualConfig: ProtocolConfigAccount,
  actualOracle: OracleSetAccount,
  expectedConfigState: ProtocolConfigAccount,
  expectedOracleState: OracleSetAccount,
): void {
  assertObjectFields(
    actualConfig as unknown as Readonly<Record<string, unknown>>,
    expectedConfigState as unknown as Readonly<Record<string, unknown>>,
    'ProtocolConfig',
  );
  assertObjectFields(
    actualOracle as unknown as Readonly<Record<string, unknown>>,
    expectedOracleState as unknown as Readonly<Record<string, unknown>>,
    'OracleSet',
  );
}

async function inspectProtocol(
  connection: Connection,
  identities: LoadedIdentities,
  activationSlot: bigint,
): Promise<ProtocolAssessment> {
  const programId = identities.program.publicKey;
  const configPda = deriveProtocolConfigPda(programId).publicKey;
  const oraclePda = deriveOracleSetPda(programId, ORACLE_SET_EPOCH).publicKey;
  const [configInfo, oracleInfo] = await Promise.all([
    connection.getAccountInfo(configPda, 'finalized'),
    connection.getAccountInfo(oraclePda, 'finalized'),
  ]);
  if (configInfo === null) {
    if (oracleInfo !== null) fail('oracle-set exists while ProtocolConfig is missing');
    return { initializeConfig: true, initializeOracleSet: true };
  }
  assertEqual(configInfo.owner.toBase58(), programId.toBase58(), 'ProtocolConfig owner');
  assertEqual(configInfo.executable, false, 'ProtocolConfig executable flag');
  const config = decodeProtocolConfig(rpcAccount(configInfo));
  if (oracleInfo === null) {
    assertObjectFields(
      config as unknown as Readonly<Record<string, unknown>>,
      expectedConfig(identities, ZERO_ADDRESS) as unknown as Readonly<Record<string, unknown>>,
      'ProtocolConfig',
    );
    return { initializeConfig: false, initializeOracleSet: true };
  }
  assertEqual(oracleInfo.owner.toBase58(), programId.toBase58(), 'OracleSet owner');
  assertEqual(oracleInfo.executable, false, 'OracleSet executable flag');
  const oracle = decodeOracleSet(rpcAccount(oracleInfo));
  verifyDecodedProtocolState(
    config,
    oracle,
    expectedConfig(identities, oraclePda.toBase58()),
    expectedOracle(identities, activationSlot),
  );
  return { initializeConfig: false, initializeOracleSet: false };
}

async function spawnSolanaDeploy(options: DevnetBootstrapOptions): Promise<void> {
  const args = [
    'program',
    'deploy',
    options.programSoPath,
    '--url',
    options.rpcUrl,
    '--keypair',
    options.roles.transactionPayer,
    '--upgrade-authority',
    options.roles.upgradeAuthority,
    '--program-id',
    options.programKeypairPath,
    '--commitment',
    'finalized',
  ];
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(options.solanaBinary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    child.once('error', () => rejectPromise(new DevnetBootstrapError('failed to start the Solana CLI')));
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new DevnetBootstrapError(`Solana CLI program deploy failed with exit code ${code ?? 'unknown'}`));
    });
  });
}

async function sendInstruction(
  connection: Connection,
  instruction: TransactionInstruction,
  payer: Keypair,
  signers: readonly Keypair[],
): Promise<string> {
  await assertDevnet(connection);
  const latest = await connection.getLatestBlockhash('finalized');
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(instruction);
  const uniqueSigners = [...new Map([payer, ...signers].map((signer) => [signer.publicKey.toBase58(), signer])).values()];
  transaction.sign(...uniqueSigners);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 3,
    preflightCommitment: 'finalized',
    skipPreflight: false,
  });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'finalized');
  if (confirmation.value.err !== null) fail('devnet transaction failed before finalization');
  await assertDevnet(connection);
  return signature;
}

async function initializeConfig(connection: Connection, identities: LoadedIdentities): Promise<void> {
  const instruction = materializeInstruction({
    kind: 'initialize_config',
    initializer: identities.upgradeAuthority.publicKey,
    configAuthority: identities.configAuthority.publicKey,
    pauseAuthority: identities.pauseAuthority.publicKey,
    marketCreationAuthority: identities.marketCreationAuthority.publicKey,
    feedOperatorAuthority: identities.feedOperatorAuthority.publicKey,
    relayerFeePayer: identities.relayerFeePayer.publicKey,
    clusterGenesisHash: decodeBase58(DEVNET_GENESIS_HASH),
    canonicalUsdcMint: DEVNET_CANONICAL_USDC_MINT,
    residualRecipient: identities.residualRecipient.publicKey,
    minimumSolPosition: DEVNET_LIMITS.minimumSolPosition,
    maximumSolPosition: DEVNET_LIMITS.maximumSolPosition,
    minimumUsdcPosition: DEVNET_LIMITS.minimumUsdcPosition,
    maximumUsdcPosition: DEVNET_LIMITS.maximumUsdcPosition,
    maximumMarketDurationSeconds: DEVNET_LIMITS.maximumMarketDurationSeconds,
    maximumResolutionDelaySeconds: DEVNET_LIMITS.maximumResolutionDelaySeconds,
    allowedTokenProgram: CLASSIC_TOKEN_PROGRAM_ID,
  }, { programId: identities.program.publicKey });
  await sendInstruction(connection, instruction, identities.transactionPayer, [identities.upgradeAuthority]);
}

async function initializeOracleSet(
  connection: Connection,
  identities: LoadedIdentities,
  activationSlot: bigint,
): Promise<void> {
  const currentSlot = BigInt(await connection.getSlot('finalized'));
  if (activationSlot < currentSlot) fail('oracle activation slot is already behind the finalized devnet slot');
  const instruction = materializeInstruction({
    kind: 'rotate_oracle_set',
    payer: identities.transactionPayer.publicKey,
    configAuthority: identities.configAuthority.publicKey,
    currentOracleSet: PublicKey.default,
    epoch: ORACLE_SET_EPOCH,
    signers: identities.oracleSigners.map((signer) => signer.publicKey),
    signatureThreshold: ORACLE_THRESHOLD,
    activationSlot,
    retirementSlot: null,
  }, { programId: identities.program.publicKey });
  await sendInstruction(connection, instruction, identities.transactionPayer, [identities.configAuthority]);
}

function publicDeployment(
  identities: LoadedIdentities,
  artifactSha256: string,
  activationSlot: bigint,
): DevnetPublicDeployment {
  const programId = identities.program.publicKey;
  return {
    network: 'devnet',
    clusterGenesisHash: DEVNET_GENESIS_HASH,
    programId: programId.toBase58(),
    programDataAddress: programDataAddress(programId).toBase58(),
    programSha256: artifactSha256,
    configPda: deriveProtocolConfigPda(programId).publicKey.toBase58(),
    oracleSetPda: deriveOracleSetPda(programId, ORACLE_SET_EPOCH).publicKey.toBase58(),
    oracleSetEpoch: ORACLE_SET_EPOCH.toString(),
    canonicalUsdcMint: DEVNET_CANONICAL_USDC_MINT,
    classicTokenProgramId: CLASSIC_TOKEN_PROGRAM_ID.toBase58(),
    limits: {
      minimumSolPosition: DEVNET_LIMITS.minimumSolPosition.toString(),
      maximumSolPosition: DEVNET_LIMITS.maximumSolPosition.toString(),
      minimumUsdcPosition: DEVNET_LIMITS.minimumUsdcPosition.toString(),
      maximumUsdcPosition: DEVNET_LIMITS.maximumUsdcPosition.toString(),
      maximumMarketDurationSeconds: DEVNET_LIMITS.maximumMarketDurationSeconds.toString(),
      maximumResolutionDelaySeconds: DEVNET_LIMITS.maximumResolutionDelaySeconds.toString(),
    },
    authorities: {
      upgrade: identities.upgradeAuthority.publicKey.toBase58(),
      config: identities.configAuthority.publicKey.toBase58(),
      pause: identities.pauseAuthority.publicKey.toBase58(),
      marketCreation: identities.marketCreationAuthority.publicKey.toBase58(),
      feedOperator: identities.feedOperatorAuthority.publicKey.toBase58(),
      relayerFeePayer: identities.relayerFeePayer.publicKey.toBase58(),
      residualRecipient: identities.residualRecipient.publicKey.toBase58(),
    },
    oracleSet: {
      signers: identities.oracleSigners.map((signer) => signer.publicKey.toBase58()) as [string, string, string],
      threshold: 2,
      activationSlot: activationSlot.toString(),
      retirementSlot: null,
    },
    custodyModeAction: 'unchanged',
  };
}

export function createSanitizedArtifacts(deployment: DevnetPublicDeployment): SanitizedArtifacts {
  const env = [
    '# Called It escrow public devnet identities. No secrets or RPC endpoints.',
    '# This fragment intentionally does not set WAGER_CUSTODY_MODE.',
    'SOLANA_NETWORK=devnet',
    `ESCROW_PROGRAM_ID=${deployment.programId}`,
    `ESCROW_GENESIS_HASH=${deployment.clusterGenesisHash}`,
    `ESCROW_CANONICAL_USDC_MINT=${deployment.canonicalUsdcMint}`,
    `ESCROW_CLASSIC_TOKEN_PROGRAM_ID=${deployment.classicTokenProgramId}`,
    `ESCROW_ORACLE_SET_PDA=${deployment.oracleSetPda}`,
    `ESCROW_ORACLE_SET_EPOCH=${deployment.oracleSetEpoch}`,
    `ESCROW_ORACLE_THRESHOLD=${deployment.oracleSet.threshold}`,
    `ESCROW_ORACLE_SIGNERS=${deployment.oracleSet.signers.join(',')}`,
    `ESCROW_CONFIG_AUTHORITY=${deployment.authorities.config}`,
    `ESCROW_PAUSE_AUTHORITY=${deployment.authorities.pause}`,
    `ESCROW_MARKET_CREATION_AUTHORITY=${deployment.authorities.marketCreation}`,
    `ESCROW_UPGRADE_AUTHORITY=${deployment.authorities.upgrade}`,
    `ESCROW_RESIDUAL_RECIPIENT=${deployment.authorities.residualRecipient}`,
    `NEXT_PUBLIC_ESCROW_PROGRAM_ID=${deployment.programId}`,
    `NEXT_PUBLIC_ESCROW_CANONICAL_USDC_MINT=${deployment.canonicalUsdcMint}`,
    `NEXT_PUBLIC_ESCROW_GENESIS_HASH=${deployment.clusterGenesisHash}`,
    '',
  ].join('\n');
  return { manifest: stableJson({ schemaVersion: 1, ...deployment }), env };
}

export function assertSanitizedArtifacts(
  artifacts: SanitizedArtifacts,
  forbiddenValues: readonly string[],
): void {
  const combined = `${artifacts.manifest}\n${artifacts.env}`;
  for (const value of forbiddenValues) {
    if (value.length > 0 && combined.includes(value)) fail('sanitized output contains forbidden private input');
  }
  if (/^(WAGER_CUSTODY_MODE|ESCROW_RELAYER_KEYPAIR_B58|SOLANA_RPC_URL)=/m.test(artifacts.env)) {
    fail('sanitized env fragment contains a forbidden activation or secret setting');
  }
  if (artifacts.manifest.includes('rpcUrl') || artifacts.manifest.includes('keypairPath')) {
    fail('sanitized manifest contains a private connection or keypair field');
  }
}

async function writePublicFile(path: string, contents: string): Promise<void> {
  const absolute = resolve(path);
  const existing = await lstat(absolute).catch(() => null);
  if (existing !== null && !existing.isFile()) fail('sanitized output target must be a regular file or not exist');
  if (existing !== null && await readFile(absolute, 'utf8') === contents) return;
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = resolve(dirname(absolute), `.${basename(absolute)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  await rename(temporary, absolute);
}

function actionNames(assessment: BootstrapAssessment): string[] {
  const actions: string[] = [];
  if (assessment.programAction === 'deploy') actions.push('deploy pinned escrow program');
  if (assessment.programAction === 'upgrade') actions.push('upgrade pinned escrow program');
  if (assessment.initializeConfig) actions.push('initialize exact ProtocolConfig');
  if (assessment.initializeOracleSet) actions.push('initialize exact 2-of-3 OracleSet');
  actions.push('write sanitized public manifest and env fragment');
  return actions;
}

function connectionFor(rpcUrl: string): Connection {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    fail('RPC URL is invalid');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') fail('RPC URL must use HTTP(S)');
  return new Connection(rpcUrl, { commitment: 'finalized', confirmTransactionInitialTimeout: 120_000 });
}

export async function bootstrapDevnet(options: DevnetBootstrapOptions): Promise<DevnetBootstrapResult> {
  if (options.oracleActivationSlot <= 0n) fail('oracle activation slot must be a positive integer');
  const [identities, artifact] = await Promise.all([
    loadIdentities(options),
    readProgramArtifact(options.programSoPath),
  ]);
  const connection = connectionFor(options.rpcUrl);
  await assertDevnet(connection);
  await verifyCanonicalUsdc(connection);
  const assessment: BootstrapAssessment = {
    programAction: await inspectProgram(connection, identities, artifact.bytes),
    ...await inspectProtocol(connection, identities, options.oracleActivationSlot),
  };
  const deployment = publicDeployment(identities, artifact.sha256, options.oracleActivationSlot);
  const artifacts = createSanitizedArtifacts(deployment);
  assertSanitizedArtifacts(artifacts, [
    options.rpcUrl,
    options.programKeypairPath,
    options.programSoPath,
    ...Object.values(options.roles).flat(),
  ]);
  const actions = actionNames(assessment);
  if (!options.execute) {
    return {
      mode: 'dry-run',
      network: 'devnet',
      programId: deployment.programId,
      configPda: deployment.configPda,
      oracleSetPda: deployment.oracleSetPda,
      actions,
      verified: assessment.programAction === 'none' && !assessment.initializeConfig && !assessment.initializeOracleSet,
      outputsWritten: false,
    };
  }

  await assertDevnet(connection);
  const currentProgramAction = await inspectProgram(connection, identities, artifact.bytes);
  if (currentProgramAction !== 'none') {
    await spawnSolanaDeploy(options);
    await assertDevnet(connection);
    const programAction = await inspectProgram(connection, identities, artifact.bytes);
    if (programAction !== 'none') fail('deployed program does not match the pinned SBF and authority');
  }

  let protocol = await inspectProtocol(connection, identities, options.oracleActivationSlot);
  if (protocol.initializeConfig) {
    await initializeConfig(connection, identities);
    protocol = await inspectProtocol(connection, identities, options.oracleActivationSlot);
  }
  if (protocol.initializeOracleSet) {
    await initializeOracleSet(connection, identities, options.oracleActivationSlot);
  }
  await assertDevnet(connection);
  const finalProgram = await inspectProgram(connection, identities, artifact.bytes);
  const finalProtocol = await inspectProtocol(connection, identities, options.oracleActivationSlot);
  if (finalProgram !== 'none' || finalProtocol.initializeConfig || finalProtocol.initializeOracleSet) {
    fail('finalized devnet state does not exactly match the requested bootstrap state');
  }
  await Promise.all([
    writePublicFile(options.manifestOutputPath, artifacts.manifest),
    writePublicFile(options.envOutputPath, artifacts.env),
  ]);
  return {
    mode: 'execute',
    network: 'devnet',
    programId: deployment.programId,
    configPda: deployment.configPda,
    oracleSetPda: deployment.oracleSetPda,
    actions,
    verified: true,
    outputsWritten: true,
  };
}
