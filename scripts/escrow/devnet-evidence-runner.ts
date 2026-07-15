import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
  DEVNET_SCENARIOS,
  parseDevnetE2eReport,
  releaseIdentity,
  type DevnetE2eReport,
  type DevnetScenario,
  type ReleaseIdentity,
} from './evidence.js';
import { parseReleaseManifest } from './manifest.js';
import {
  CLASSIC_TOKEN_PROGRAM,
  UPGRADEABLE_LOADER,
  captureReleaseManifest,
  decodeClassicMint,
  decodeProgramDataAddress,
  decodeUpgradeAuthority,
  findProgramAddress,
} from './release.js';
import {
  DEVNET_CANONICAL_USDC_MINT,
  DEVNET_GENESIS_HASH,
  PINNED_ESCROW_PROGRAM_ID,
} from './devnet-bootstrap.js';
import type { EvidenceRpcReader, ReleaseManifest } from './types.js';
import { bigintLe, decodeBase58, equalJson } from './util.js';

const TRANSACTION_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const DEVNET_E2E_ROLE_ENV = Object.freeze({
  configAuthority: 'ESCROW_E2E_CONFIG_AUTHORITY_KEYPAIR_PATH',
  marketCreationAuthority: 'ESCROW_E2E_MARKET_CREATION_AUTHORITY_KEYPAIR_PATH',
  feedOperatorAuthority: 'ESCROW_E2E_FEED_OPERATOR_AUTHORITY_KEYPAIR_PATH',
  pauseAuthority: 'ESCROW_E2E_PAUSE_AUTHORITY_KEYPAIR_PATH',
  relayerFeePayer: 'ESCROW_E2E_RELAYER_FEE_PAYER_KEYPAIR_PATH',
  oracleSigner1: 'ESCROW_E2E_ORACLE_SIGNER_1_KEYPAIR_PATH',
  oracleSigner2: 'ESCROW_E2E_ORACLE_SIGNER_2_KEYPAIR_PATH',
  solUser: 'ESCROW_E2E_SOL_USER_KEYPAIR_PATH',
  usdcUser: 'ESCROW_E2E_USDC_USER_KEYPAIR_PATH',
  directClaimUser: 'ESCROW_E2E_DIRECT_CLAIM_USER_KEYPAIR_PATH',
});

export class DevnetEvidenceRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevnetEvidenceRunnerError';
  }
}

export interface DevnetRoleCredentials {
  readonly configAuthority: Keypair;
  readonly marketCreationAuthority: Keypair;
  readonly feedOperatorAuthority: Keypair;
  readonly pauseAuthority: Keypair;
  readonly relayerFeePayer: Keypair;
  readonly oracleSigners: readonly [Keypair, Keypair];
  readonly solUser: Keypair;
  readonly usdcUser: Keypair;
  readonly directClaimUser: Keypair;
}

export interface DevnetScenarioContext {
  readonly manifest: ReleaseManifest;
  readonly rpcUrl: string;
  readonly rpc: EvidenceRpcReader;
  readonly credentials: DevnetRoleCredentials;
  readonly runId: string;
}

export interface DevnetScenarioDriver {
  execute(
    id: DevnetScenario['id'],
    context: DevnetScenarioContext,
  ): Promise<{ readonly transactionSignature: string }>;
  restoreBaseline(context: DevnetScenarioContext): Promise<void>;
}

export interface DevnetE2ePreflightReport {
  readonly schemaVersion: 1;
  readonly kind: 'devnet-e2e-preflight';
  readonly mode: 'dry-run';
  readonly releaseIdentity: ReleaseIdentity;
  readonly runId: string;
  readonly checkedAt: string;
  readonly scenarios: typeof DEVNET_SCENARIOS;
  readonly checks: readonly string[];
}

export interface DevnetEvidenceRunnerOptions {
  readonly mode: 'dry-run' | 'execute';
  readonly manifest: ReleaseManifest;
  readonly rpcUrl: string;
  readonly rpc: EvidenceRpcReader;
  readonly credentials: DevnetRoleCredentials;
  readonly driver?: DevnetScenarioDriver;
  readonly runId?: string;
  readonly now?: () => Date;
}

function fail(message: string): never {
  throw new DevnetEvidenceRunnerError(message);
}

function validateRpcUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('ESCROW_E2E_RPC_URL must be a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('ESCROW_E2E_RPC_URL must use HTTP(S)');
  }
}

export function validateDevnetManifest(value: ReleaseManifest): ReleaseManifest {
  const manifest = parseReleaseManifest(value);
  if (manifest.network !== 'devnet') fail('devnet evidence runner supports only Solana devnet; mainnet is refused');
  if (manifest.clusterGenesisHash !== DEVNET_GENESIS_HASH) fail('manifest is not bound to the exact Solana devnet genesis');
  if (manifest.programId !== PINNED_ESCROW_PROGRAM_ID) fail('manifest program ID is not the repository-pinned devnet escrow program');
  if (manifest.upgradeableLoaderProgramId !== UPGRADEABLE_LOADER) fail('manifest program loader is unsupported');
  if (manifest.config.canonicalUsdcMint !== DEVNET_CANONICAL_USDC_MINT) fail('manifest canonical USDC mint is not the pinned devnet mint');
  if (manifest.config.allowedTokenProgram !== CLASSIC_TOKEN_PROGRAM) fail('manifest token program must be classic SPL Token');
  if (manifest.config.paused) fail('devnet evidence baseline must be unpaused before the run');
  if (manifest.oracleSet.retirementSlot !== null) fail('devnet evidence oracle set must be active and non-retired');
  const expectedProgramData = PublicKey.findProgramAddressSync(
    [new PublicKey(manifest.programId).toBytes()],
    new PublicKey(UPGRADEABLE_LOADER),
  )[0].toBase58();
  if (manifest.programDataAddress !== expectedProgramData) fail('manifest program-data address is not canonical');
  if (manifest.configPda !== findProgramAddress([Buffer.from('config')], manifest.programId).address) {
    fail('manifest protocol config PDA is not canonical');
  }
  if (
    manifest.oracleSet.address
    !== findProgramAddress([Buffer.from('oracle-set'), bigintLe(BigInt(manifest.oracleSet.epoch))], manifest.programId).address
  ) {
    fail('manifest oracle-set PDA is not canonical');
  }
  return manifest;
}

function publicKey(keypair: Keypair): string {
  return keypair.publicKey.toBase58();
}

export function validateDevnetRoleCredentials(
  manifest: ReleaseManifest,
  credentials: DevnetRoleCredentials,
): readonly string[] {
  const expected = [
    ['config authority', publicKey(credentials.configAuthority), manifest.config.configAuthority],
    ['market-creation authority', publicKey(credentials.marketCreationAuthority), manifest.config.marketCreationAuthority],
    ['feed-operator authority', publicKey(credentials.feedOperatorAuthority), manifest.config.feedOperatorAuthority],
    ['pause authority', publicKey(credentials.pauseAuthority), manifest.config.pauseAuthority],
    ['relayer fee payer', publicKey(credentials.relayerFeePayer), manifest.config.relayerFeePayer],
  ] as const;
  for (const [label, actual, required] of expected) {
    if (actual !== required) fail(`${label} credential does not match the public manifest`);
  }

  const oracleKeys = credentials.oracleSigners.map(publicKey);
  if (oracleKeys[0] === oracleKeys[1] || oracleKeys.some((key) => !manifest.oracleSet.signers.includes(key))) {
    fail('oracle credentials must be two distinct signers from the public manifest');
  }
  const allKeys = [
    ...expected.map((entry) => entry[1]),
    ...oracleKeys,
    publicKey(credentials.solUser),
    publicKey(credentials.usdcUser),
    publicKey(credentials.directClaimUser),
  ];
  if (new Set(allKeys).size !== allKeys.length) fail('every devnet evidence role and user credential must be distinct');
  return [
    'keypair-derived operational roles match public manifest',
    'two distinct threshold oracle credentials match public manifest',
    'evidence user credentials are distinct from privileged roles',
  ];
}

async function readKeypairFromEnvironment(
  environment: NodeJS.ProcessEnv,
  environmentName: string,
  label: string,
): Promise<Keypair> {
  const path = environment[environmentName];
  if (path === undefined || path.length === 0) fail(`${label} credential is not configured in ${environmentName}`);
  const file = await lstat(path).catch(() => null);
  if (file === null || !file.isFile()) fail(`${label} credential must reference a regular file`);
  if ((file.mode & 0o077) !== 0) fail(`${label} credential file must have mode 0600 or stricter`);
  const raw = await readFile(path, 'utf8').catch(() => fail(`${label} credential could not be read`));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail(`${label} credential is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    fail(`${label} credential must be a 64-byte Solana JSON keypair`);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  } catch {
    fail(`${label} credential is not a valid Solana keypair`);
  }
}

export async function loadDevnetRoleCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DevnetRoleCredentials> {
  const values = await Promise.all([
    readKeypairFromEnvironment(environment, DEVNET_E2E_ROLE_ENV.configAuthority, 'config authority'),
    readKeypairFromEnvironment(environment, DEVNET_E2E_ROLE_ENV.marketCreationAuthority, 'market-creation authority'),
    readKeypairFromEnvironment(environment, DEVNET_E2E_ROLE_ENV.feedOperatorAuthority, 'feed-operator authority'),
    readKeypairFromEnvironment(environment, DEVNET_E2E_ROLE_ENV.pauseAuthority, 'pause authority'),
    readKeypairFromEnvironment(environment, DEVNET_E2E_ROLE_ENV.relayerFeePayer, 'relayer fee payer'),
    readKeypairFromEnvironment(environment, DEVNET_E2E_ROLE_ENV.oracleSigner1, 'oracle signer 1'),
    readKeypairFromEnvironment(environment, DEVNET_E2E_ROLE_ENV.oracleSigner2, 'oracle signer 2'),
    readKeypairFromEnvironment(environment, DEVNET_E2E_ROLE_ENV.solUser, 'SOL user'),
    readKeypairFromEnvironment(environment, DEVNET_E2E_ROLE_ENV.usdcUser, 'USDC user'),
    readKeypairFromEnvironment(environment, DEVNET_E2E_ROLE_ENV.directClaimUser, 'direct-claim user'),
  ]);
  const credentials = {} as DevnetRoleCredentials;
  Object.defineProperties(credentials, {
    configAuthority: { value: values[0]!, enumerable: false },
    marketCreationAuthority: { value: values[1]!, enumerable: false },
    feedOperatorAuthority: { value: values[2]!, enumerable: false },
    pauseAuthority: { value: values[3]!, enumerable: false },
    relayerFeePayer: { value: values[4]!, enumerable: false },
    oracleSigners: { value: Object.freeze([values[5]!, values[6]!] as const), enumerable: false },
    solUser: { value: values[7]!, enumerable: false },
    usdcUser: { value: values[8]!, enumerable: false },
    directClaimUser: { value: values[9]!, enumerable: false },
  });
  return Object.freeze(credentials);
}

function checkedElfRange(offset: bigint, size: bigint, available: number): number | null {
  const end = offset + size;
  if (offset < 0n || size < 0n || end > BigInt(available) || end > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(end);
}

function elfFileLength(bytes: Buffer): number | null {
  if (
    bytes.length < 64
    || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || bytes[4] !== 2
    || bytes[5] !== 1
  ) return null;
  const programHeaderOffset = bytes.readBigUInt64LE(32);
  const sectionHeaderOffset = bytes.readBigUInt64LE(40);
  const headerLength = bytes.readUInt16LE(52);
  const programEntryLength = bytes.readUInt16LE(54);
  const programEntryCount = bytes.readUInt16LE(56);
  const sectionEntryLength = bytes.readUInt16LE(58);
  const sectionEntryCount = bytes.readUInt16LE(60);
  if (headerLength < 64 || programEntryLength < 56 || sectionEntryLength < 64) return null;
  let logicalLength = headerLength;
  const programTableEnd = checkedElfRange(
    programHeaderOffset,
    BigInt(programEntryLength) * BigInt(programEntryCount),
    bytes.length,
  );
  const sectionTableEnd = checkedElfRange(
    sectionHeaderOffset,
    BigInt(sectionEntryLength) * BigInt(sectionEntryCount),
    bytes.length,
  );
  if (programTableEnd === null || sectionTableEnd === null) return null;
  logicalLength = Math.max(logicalLength, programTableEnd, sectionTableEnd);

  for (let index = 0; index < programEntryCount; index += 1) {
    const entry = Number(programHeaderOffset) + index * programEntryLength;
    const end = checkedElfRange(bytes.readBigUInt64LE(entry + 8), bytes.readBigUInt64LE(entry + 32), bytes.length);
    if (end === null) return null;
    logicalLength = Math.max(logicalLength, end);
  }
  for (let index = 0; index < sectionEntryCount; index += 1) {
    const entry = Number(sectionHeaderOffset) + index * sectionEntryLength;
    const sectionType = bytes.readUInt32LE(entry + 4);
    if (sectionType === 8) continue; // SHT_NOBITS occupies memory but has no file bytes.
    const end = checkedElfRange(bytes.readBigUInt64LE(entry + 24), bytes.readBigUInt64LE(entry + 32), bytes.length);
    if (end === null) return null;
    logicalLength = Math.max(logicalLength, end);
  }
  return logicalLength;
}

function deployedProgramMatchesHash(programData: Buffer, expectedSha256: string): boolean {
  if (programData.length <= 45) return false;
  const deployed = programData.subarray(45);
  const length = elfFileLength(deployed);
  if (length === null || deployed.subarray(length).some((byte) => byte !== 0)) return false;
  return createHash('sha256').update(deployed.subarray(0, length)).digest('hex') === expectedSha256;
}

export async function verifyDevnetDeployment(
  manifestValue: ReleaseManifest,
  rpc: EvidenceRpcReader,
): Promise<readonly string[]> {
  const manifest = validateDevnetManifest(manifestValue);
  const genesis = await rpc.genesisHash();
  if (genesis !== DEVNET_GENESIS_HASH || genesis !== manifest.clusterGenesisHash) fail('RPC is not the exact Solana devnet cluster');

  const [program, programData, config, oracleSet, mint] = await Promise.all([
    rpc.account(manifest.programId),
    rpc.account(manifest.programDataAddress),
    rpc.account(manifest.configPda),
    rpc.account(manifest.oracleSet.address),
    rpc.account(manifest.config.canonicalUsdcMint),
  ]);
  if (program.owner !== UPGRADEABLE_LOADER || !program.executable) fail('manifest program is not an executable upgradeable program');
  if (decodeProgramDataAddress(program) !== manifest.programDataAddress) fail('deployed program-data address differs from public manifest');
  if (programData.owner !== UPGRADEABLE_LOADER || programData.executable) fail('deployed program-data account is invalid');
  if (decodeUpgradeAuthority(programData) !== manifest.upgradeAuthority) fail('deployed upgrade authority differs from public manifest');
  if (!deployedProgramMatchesHash(programData.data, manifest.build.sbfSha256)) fail('deployed SBF hash differs from public manifest');
  if (config.owner !== manifest.programId || config.executable) fail('protocol config account owner is invalid');
  if (oracleSet.owner !== manifest.programId || oracleSet.executable) fail('oracle-set account owner is invalid');
  if (mint.owner !== CLASSIC_TOKEN_PROGRAM || mint.executable) fail('canonical devnet USDC mint owner is invalid');
  const decodedMint = decodeClassicMint(mint);
  if (decodedMint.decimals !== 6 || !decodedMint.initialized) fail('canonical devnet USDC mint layout is invalid');

  const captured = await captureReleaseManifest('devnet', manifest.build, rpc);
  if (!equalJson(captured, manifest)) fail('deployed protocol state differs from public manifest');
  return [
    'exact Solana devnet genesis',
    'pinned executable program and deployed SBF hash',
    'protocol config and oracle set match public manifest',
    'canonical classic SPL devnet USDC mint',
  ];
}

function safeDate(date: Date, label: string): Date {
  if (Number.isNaN(date.getTime())) fail(`${label} is invalid`);
  return date;
}

async function exactDevnetGenesis(rpc: EvidenceRpcReader): Promise<void> {
  let genesis: string;
  try {
    genesis = await rpc.genesisHash();
  } catch {
    fail('RPC genesis check failed before a transaction-capable step');
  }
  if (genesis !== DEVNET_GENESIS_HASH) fail('RPC stopped reporting exact Solana devnet; refusing further actions');
}

export async function runDevnetEvidence(
  options: DevnetEvidenceRunnerOptions,
): Promise<DevnetE2ePreflightReport | DevnetE2eReport> {
  const manifest = validateDevnetManifest(options.manifest);
  validateRpcUrl(options.rpcUrl);
  const roleChecks = validateDevnetRoleCredentials(manifest, options.credentials);
  const deploymentChecks = await verifyDevnetDeployment(manifest, options.rpc);
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? randomUUID();
  if (runId.length === 0 || runId.length > 128) fail('run ID must contain between 1 and 128 characters');

  if (options.mode === 'dry-run') {
    return {
      schemaVersion: 1,
      kind: 'devnet-e2e-preflight',
      mode: 'dry-run',
      releaseIdentity: releaseIdentity(manifest),
      runId,
      checkedAt: safeDate(now(), 'preflight timestamp').toISOString(),
      scenarios: DEVNET_SCENARIOS,
      checks: [...deploymentChecks, ...roleChecks, 'dry-run submitted zero transactions'],
    };
  }
  if (options.driver === undefined) fail('execute mode requires a devnet scenario driver');

  const context: DevnetScenarioContext = {
    manifest,
    rpcUrl: options.rpcUrl,
    rpc: options.rpc,
    credentials: options.credentials,
    runId,
  };
  const executionStarted = safeDate(now(), 'execution start timestamp');
  const scenarios: DevnetScenario[] = [];
  const signatures = new Set<string>();
  let executionFailure: DevnetEvidenceRunnerError | undefined;

  try {
    for (const id of DEVNET_SCENARIOS) {
      await exactDevnetGenesis(options.rpc);
      let transactionSignature: string;
      try {
        ({ transactionSignature } = await options.driver.execute(id, context));
      } catch {
        fail(`scenario ${id} failed without exposing driver or credential details`);
      }
      await exactDevnetGenesis(options.rpc);
      if (decodeBase58(transactionSignature).length !== 64) fail(`scenario ${id} returned an invalid transaction signature`);
      if (signatures.has(transactionSignature)) fail(`scenario ${id} reused an earlier transaction signature`);
      signatures.add(transactionSignature);

      let transaction: Awaited<ReturnType<EvidenceRpcReader['finalizedTransaction']>>;
      try {
        transaction = await options.rpc.finalizedTransaction(transactionSignature);
      } catch {
        fail(`scenario ${id} transaction is not finalized and successful`);
      }
      if (!transaction.accountKeys.includes(manifest.programId)) fail(`scenario ${id} transaction does not invoke the manifest program`);
      const observed = new Date(transaction.blockTime * 1_000);
      const checkedNow = safeDate(now(), 'scenario verification timestamp');
      if (
        observed.getTime() < executionStarted.getTime() - TRANSACTION_CLOCK_SKEW_MS
        || observed.getTime() > checkedNow.getTime() + TRANSACTION_CLOCK_SKEW_MS
      ) {
        fail(`scenario ${id} transaction is outside the current execution window`);
      }
      scenarios.push({ id, transactionSignature, observedAt: observed.toISOString() });
    }
  } catch (error) {
    executionFailure = error instanceof DevnetEvidenceRunnerError
      ? error
      : new DevnetEvidenceRunnerError('devnet evidence execution failed without exposing sensitive details');
  }

  try {
    await exactDevnetGenesis(options.rpc);
    await options.driver.restoreBaseline(context);
  } catch {
    fail('devnet scenario driver failed to restore the public-manifest baseline');
  }
  if (executionFailure !== undefined) throw executionFailure;

  await exactDevnetGenesis(options.rpc);
  await verifyDevnetDeployment(manifest, options.rpc);
  const completed = safeDate(now(), 'execution completion timestamp');
  const observedTimes = scenarios.map((scenario) => Date.parse(scenario.observedAt));
  const reportStarted = new Date(Math.min(executionStarted.getTime(), ...observedTimes));
  const reportCompleted = new Date(Math.max(completed.getTime(), ...observedTimes));
  return parseDevnetE2eReport({
    schemaVersion: 1,
    kind: 'devnet-e2e-report',
    releaseIdentity: releaseIdentity(manifest),
    startedAt: reportStarted.toISOString(),
    completedAt: reportCompleted.toISOString(),
    runId,
    scenarios,
  });
}
