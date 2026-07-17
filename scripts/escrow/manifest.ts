import { readFile } from 'node:fs/promises';

import type {
  BuildManifest,
  Network,
  OracleSetExpectation,
  ReleaseConfigExpectation,
  ReleaseManifest,
} from './types.js';
import {
  asAtomicString,
  asBoolean,
  asCommit,
  asInteger,
  asPublicKey,
  asRecord,
  asSha256,
  asString,
  failInput,
  rejectExtraKeys,
  sha256File,
  sha256Tree,
} from './util.js';

const NETWORKS: readonly Network[] = ['localnet', 'devnet', 'testnet', 'mainnet-beta'];
const BUILD_KEYS = [
  'schemaVersion',
  'sourceCommit',
  'programId',
  'sbfSha256',
  'idlSha256',
  'sourceSha256',
  'lockSha256',
] as const;
const CONFIG_KEYS = [
  'custodyVersion',
  'paused',
  'configAuthority',
  'pauseAuthority',
  'marketCreationAuthority',
  'feedOperatorAuthority',
  'oracleSet',
  'relayerFeePayer',
  'residualRecipient',
  'canonicalUsdcMint',
  'allowedTokenProgram',
  'minSolPosition',
  'maxSolPosition',
  'minUsdcPosition',
  'maxUsdcPosition',
  'maxMarketDurationSeconds',
  'maxResolutionDelaySeconds',
] as const;
const ORACLE_KEYS = [
  'address',
  'custodyVersion',
  'epoch',
  'signers',
  'threshold',
  'activationSlot',
  'retirementSlot',
] as const;
const RELEASE_KEYS = [
  'schemaVersion',
  'network',
  'clusterGenesisHash',
  'programId',
  'upgradeableLoaderProgramId',
  'programDataAddress',
  'upgradeAuthority',
  'configPda',
  'build',
  'config',
  'oracleSet',
] as const;

export function parseBuildManifest(value: unknown, label = 'build manifest'): BuildManifest {
  const record = asRecord(value, label);
  rejectExtraKeys(record, BUILD_KEYS, label);
  if (asInteger(record.schemaVersion, `${label}.schemaVersion`) !== 1) failInput(`${label}.schemaVersion must be 1`);
  return {
    schemaVersion: 1,
    sourceCommit: asCommit(record.sourceCommit, `${label}.sourceCommit`),
    programId: asPublicKey(record.programId, `${label}.programId`),
    sbfSha256: asSha256(record.sbfSha256, `${label}.sbfSha256`),
    idlSha256: asSha256(record.idlSha256, `${label}.idlSha256`),
    sourceSha256: asSha256(record.sourceSha256, `${label}.sourceSha256`),
    lockSha256: asSha256(record.lockSha256, `${label}.lockSha256`),
  };
}

function parseConfig(value: unknown): ReleaseConfigExpectation {
  const record = asRecord(value, 'release.config');
  rejectExtraKeys(record, CONFIG_KEYS, 'release.config');
  const custodyVersion = asInteger(record.custodyVersion, 'release.config.custodyVersion');
  if (custodyVersion <= 0 || custodyVersion > 255) failInput('release.config.custodyVersion must fit u8');
  const config: ReleaseConfigExpectation = {
    custodyVersion,
    paused: asBoolean(record.paused, 'release.config.paused'),
    configAuthority: asPublicKey(record.configAuthority, 'release.config.configAuthority'),
    pauseAuthority: asPublicKey(record.pauseAuthority, 'release.config.pauseAuthority'),
    marketCreationAuthority: asPublicKey(record.marketCreationAuthority, 'release.config.marketCreationAuthority'),
    feedOperatorAuthority: asPublicKey(record.feedOperatorAuthority, 'release.config.feedOperatorAuthority'),
    oracleSet: asPublicKey(record.oracleSet, 'release.config.oracleSet'),
    relayerFeePayer: asPublicKey(record.relayerFeePayer, 'release.config.relayerFeePayer'),
    residualRecipient: asPublicKey(record.residualRecipient, 'release.config.residualRecipient'),
    canonicalUsdcMint: asPublicKey(record.canonicalUsdcMint, 'release.config.canonicalUsdcMint'),
    allowedTokenProgram: asPublicKey(record.allowedTokenProgram, 'release.config.allowedTokenProgram'),
    minSolPosition: asAtomicString(record.minSolPosition, 'release.config.minSolPosition'),
    maxSolPosition: asAtomicString(record.maxSolPosition, 'release.config.maxSolPosition'),
    minUsdcPosition: asAtomicString(record.minUsdcPosition, 'release.config.minUsdcPosition'),
    maxUsdcPosition: asAtomicString(record.maxUsdcPosition, 'release.config.maxUsdcPosition'),
    maxMarketDurationSeconds: asAtomicString(record.maxMarketDurationSeconds, 'release.config.maxMarketDurationSeconds'),
    maxResolutionDelaySeconds: asAtomicString(record.maxResolutionDelaySeconds, 'release.config.maxResolutionDelaySeconds'),
  };
  if (BigInt(config.minSolPosition) === 0n || BigInt(config.minSolPosition) > BigInt(config.maxSolPosition)) {
    failInput('release SOL position caps are invalid');
  }
  if (BigInt(config.minUsdcPosition) === 0n || BigInt(config.minUsdcPosition) > BigInt(config.maxUsdcPosition)) {
    failInput('release USDC position caps are invalid');
  }
  if (BigInt(config.maxMarketDurationSeconds) === 0n || BigInt(config.maxResolutionDelaySeconds) === 0n) {
    failInput('release duration bounds must be positive');
  }
  return config;
}

function parseOracleSet(value: unknown): OracleSetExpectation {
  const record = asRecord(value, 'release.oracleSet');
  rejectExtraKeys(record, ORACLE_KEYS, 'release.oracleSet');
  const rawSigners = record.signers;
  if (!Array.isArray(rawSigners) || rawSigners.length !== 3) failInput('release.oracleSet.signers must contain exactly three keys');
  const signers = rawSigners.map((entry, index) => asPublicKey(entry, `release.oracleSet.signers[${index}]`));
  if (new Set(signers).size !== 3) failInput('release.oracleSet.signers must be distinct');
  if (asInteger(record.threshold, 'release.oracleSet.threshold') !== 2) failInput('release.oracleSet.threshold must be exactly 2');
  const retirementSlot = record.retirementSlot === null
    ? null
    : asAtomicString(record.retirementSlot, 'release.oracleSet.retirementSlot');
  const custodyVersion = asInteger(record.custodyVersion, 'release.oracleSet.custodyVersion');
  if (custodyVersion <= 0 || custodyVersion > 255) failInput('release.oracleSet.custodyVersion must fit u8');
  return {
    address: asPublicKey(record.address, 'release.oracleSet.address'),
    custodyVersion,
    epoch: asAtomicString(record.epoch, 'release.oracleSet.epoch'),
    signers: [signers[0]!, signers[1]!, signers[2]!],
    threshold: 2,
    activationSlot: asAtomicString(record.activationSlot, 'release.oracleSet.activationSlot'),
    retirementSlot,
  };
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const record = asRecord(value, 'release manifest');
  rejectExtraKeys(record, RELEASE_KEYS, 'release manifest');
  if (asInteger(record.schemaVersion, 'release.schemaVersion') !== 1) failInput('release.schemaVersion must be 1');
  const network = asString(record.network, 'release.network');
  if (!NETWORKS.includes(network as Network)) failInput('release.network is unsupported');
  const build = parseBuildManifest(record.build, 'release.build');
  const programId = asPublicKey(record.programId, 'release.programId');
  if (build.programId !== programId) failInput('release.build.programId does not match release.programId');
  const config = parseConfig(record.config);
  const oracleSet = parseOracleSet(record.oracleSet);
  if (config.oracleSet !== oracleSet.address) failInput('release config and oracle set addresses differ');
  if (config.custodyVersion !== oracleSet.custodyVersion) failInput('config and oracle custody versions differ');
  return {
    schemaVersion: 1,
    network: network as Network,
    clusterGenesisHash: asPublicKey(record.clusterGenesisHash, 'release.clusterGenesisHash'),
    programId,
    upgradeableLoaderProgramId: asPublicKey(record.upgradeableLoaderProgramId, 'release.upgradeableLoaderProgramId'),
    programDataAddress: asPublicKey(record.programDataAddress, 'release.programDataAddress'),
    upgradeAuthority: asPublicKey(record.upgradeAuthority, 'release.upgradeAuthority'),
    configPda: asPublicKey(record.configPda, 'release.configPda'),
    build,
    config,
    oracleSet,
  };
}

export interface ArtifactPaths {
  readonly programSo: string;
  readonly idl: string;
  readonly source: string;
  readonly lock: string;
}

export async function buildProvenance(sourceCommit: string, paths: ArtifactPaths): Promise<BuildManifest> {
  const idlRaw = await readFile(paths.idl, 'utf8').catch(() => failInput(`cannot read IDL: ${paths.idl}`));
  let idl: unknown;
  try {
    idl = JSON.parse(idlRaw) as unknown;
  } catch {
    failInput(`invalid IDL JSON: ${paths.idl}`);
  }
  const idlRecord = asRecord(idl, 'IDL');
  const programId = asPublicKey(idlRecord.address, 'IDL.address');
  return {
    schemaVersion: 1,
    sourceCommit: asCommit(sourceCommit, 'source commit'),
    programId,
    sbfSha256: await sha256File(paths.programSo).catch(() => failInput(`cannot hash SBF: ${paths.programSo}`)),
    idlSha256: await sha256File(paths.idl),
    sourceSha256: await sha256Tree(paths.source),
    lockSha256: await sha256File(paths.lock).catch(() => failInput(`cannot hash lockfile: ${paths.lock}`)),
  };
}
