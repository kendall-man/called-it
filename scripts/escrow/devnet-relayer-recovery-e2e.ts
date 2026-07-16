#!/usr/bin/env node
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createEscrowDb } from '../../packages/db/src/index.js';
import {
  derivePositionLotPda,
  deriveUserPositionPda,
} from '../../packages/escrow-sdk/src/index.js';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';

import {
  SolanaEscrowAccountReader,
  SolanaEscrowRecoveryChain,
} from '../../apps/engine/src/escrow/solana-accounts.js';
import { createEscrowRecoveryFinalityVerifier } from '../../apps/engine/src/escrow/recovery-finality.js';
import {
  createEscrowRecoveryTransactionBuilder,
} from '../../apps/engine/src/escrow/recovery-relayer.js';
import {
  restoreSettlement,
  restoreSignatures,
  restoreVoid,
  type EscrowRecoveryPayload,
} from '../../apps/engine/src/escrow/recovery-payload.js';
import {
  createEscrowRelayerWorker,
  type EscrowRelayChain,
  type EscrowRelayerFinalityVerifier,
  type EscrowRelayerPreparedTransaction,
  type EscrowRelayerRunResult,
  type EscrowRelayerTransactionBuilder,
  type EscrowRelayerWorkerDatabase,
} from '../../apps/engine/src/escrow/relayer-worker.js';
import { createEscrowSolanaRpc } from '../../apps/engine/src/escrow/solana-rpc.js';
import {
  createEscrowRecoveryService,
  type EscrowRecoveryDeployment,
  type EscrowRecoveryRequest,
} from '../../apps/engine/src/escrow/recovery-workflows.js';
import { releaseIdentity, type ReleaseIdentity } from './evidence.js';
import { parseReleaseManifest } from './manifest.js';
import { JsonRpcReader } from './release.js';
import type { ReleaseManifest } from './types.js';
import { readJson, sha256, stableJson } from './util.js';
import {
  validateDevnetManifest,
  verifyDevnetDeployment,
} from './devnet-evidence-runner.js';

const WRITE_ENABLE_VALUE = 'I_UNDERSTAND_THIS_WRITES_DEVNET';
const DEDICATED_DATABASE_VALUE = 'I_UNDERSTAND_THIS_DATABASE_MUST_BE_IDLE';
const RECOVERY_KINDS = [
  'settlement_submission',
  'timeout_monitoring',
  'auto_claim',
  'account_close',
] as const;

const USAGE = `Usage:
  tsx scripts/escrow/devnet-relayer-recovery-e2e.ts --manifest FILE --request FILE [--out FILE]
  tsx scripts/escrow/devnet-relayer-recovery-e2e.ts --manifest FILE --request FILE --out FILE --execute

Dry-run is the default. Execute mode requires these environment variables:
  ESCROW_RELAYER_RECOVERY_ENABLE_DEVNET_WRITES=${WRITE_ENABLE_VALUE}
  ESCROW_RELAYER_RECOVERY_DEDICATED_DB=${DEDICATED_DATABASE_VALUE}
  ESCROW_RELAYER_RECOVERY_RPC_URL
  ESCROW_RELAYER_RECOVERY_SUPABASE_URL
  ESCROW_RELAYER_RECOVERY_SUPABASE_SERVICE_ROLE_KEY
  ESCROW_RELAYER_RECOVERY_FEE_PAYER_KEYPAIR_PATH

The request file is an EscrowRecoveryRequest encoded as JSON. Bigints and
attestation byte arrays use the existing recovery payload decimal/hex forms.`;

export class DevnetRelayerRecoveryE2eError extends Error {
  readonly name = 'DevnetRelayerRecoveryE2eError';
}

function fail(message: string): never {
  throw new DevnetRelayerRecoveryE2eError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  return value.map((entry, index) => stringValue(entry, `${label}[${index}]`));
}

function assertPublicKey(value: string, label: string): string {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    fail(`${label} must be a Solana public key`);
  }
}

export function parseRecoveryRequest(value: unknown): EscrowRecoveryRequest {
  const input = record(value, 'recovery request');
  const operation = stringValue(input.operation, 'recovery request.operation');
  if (![
    'settle_market',
    'void_market',
    'timeout_void',
    'calculate_position_entitlement',
    'claim_position_for',
    'close_position_lots',
    'close_position',
    'close_market',
  ].includes(operation)) fail('recovery request operation is unsupported');
  const marketPda = assertPublicKey(
    stringValue(input.marketPda, 'recovery request.marketPda'),
    'recovery request.marketPda',
  );
  if (operation === 'settle_market' || operation === 'void_market') {
    if (!Array.isArray(input.signatures)) fail('recovery request.signatures must be an array');
    const signatures = restoreSignatures(
      input.signatures as EscrowRecoveryPayload['signatures'],
    );
    return operation === 'settle_market'
      ? { operation, marketPda, attestation: restoreSettlement(input.attestation), signatures }
      : { operation, marketPda, attestation: restoreVoid(input.attestation), signatures };
  }
  if (operation === 'timeout_void' || operation === 'close_market') {
    return { operation, marketPda };
  }
  const owner = assertPublicKey(
    stringValue(input.owner, 'recovery request.owner'),
    'recovery request.owner',
  );
  if (operation === 'calculate_position_entitlement' || operation === 'claim_position_for' || operation === 'close_position') {
    return { operation, marketPda, owner };
  }
  if (operation === 'close_position_lots') {
    const lotNonces = stringArray(input.lotNonces, 'recovery request.lotNonces').map((nonce) => {
      if (!/^\d+$/.test(nonce)) fail('recovery request lot nonces must be unsigned decimal strings');
      return BigInt(nonce);
    });
    return { operation, marketPda, owner, lotNonces };
  }
  fail('recovery request operation is unsupported');
}

export function assertLiveExecutionEnabled(environment: NodeJS.ProcessEnv): void {
  if (environment['ESCROW_RELAYER_RECOVERY_ENABLE_DEVNET_WRITES'] !== WRITE_ENABLE_VALUE) {
    fail('devnet writes are disabled; the exact write-enable acknowledgement is required');
  }
  if (environment['ESCROW_RELAYER_RECOVERY_DEDICATED_DB'] !== DEDICATED_DATABASE_VALUE) {
    fail('execute mode requires an acknowledged dedicated idle database');
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  return stringValue(environment[name], name);
}

function assertHttpUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a valid URL`);
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username !== '' || parsed.password !== '') {
    fail(`${label} must be an HTTP(S) URL without embedded credentials`);
  }
  return value;
}

async function loadFeePayer(path: string): Promise<Keypair> {
  const stat = await lstat(path).catch(() => null);
  if (stat === null || !stat.isFile()) fail('fee-payer credential must reference a regular file');
  if ((stat.mode & 0o077) !== 0) fail('fee-payer credential file must have mode 0600 or stricter');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    fail('fee-payer credential is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some(
    (byte) => !Number.isInteger(byte) || byte < 0 || byte > 255,
  )) fail('fee-payer credential must be a 64-byte Solana JSON keypair');
  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  } catch {
    fail('fee-payer credential is not a valid Solana keypair');
  }
}

function transactionBlockhash(rawTransactionBase64: string): string {
  try {
    return VersionedTransaction.deserialize(
      Buffer.from(rawTransactionBase64, 'base64'),
    ).message.recentBlockhash;
  } catch {
    fail('relayer persisted an invalid versioned transaction');
  }
}

function oneResult(
  results: readonly EscrowRelayerRunResult[],
  phase: string,
): EscrowRelayerRunResult {
  if (results.length !== 1 || results[0] === undefined) fail(`${phase} did not process exactly one recovery job`);
  return results[0];
}

interface SignedRecord extends EscrowRelayerPreparedTransaction {
  readonly jobId: string;
  readonly sequence: number;
}

interface RetryRecord {
  readonly errorCode: string;
  readonly confirmationUnknown: boolean;
  readonly fullHistoryCheckedAtIso?: string | null;
  readonly currentBlockHeight?: bigint | null;
}

interface LifecycleObservation {
  sequence: number;
  readonly signed: SignedRecord[];
  readonly retries: RetryRecord[];
  readonly events: string[];
}

function observeDatabase(
  db: EscrowRelayerWorkerDatabase,
  expectedJobId: string,
  observation: LifecycleObservation,
): EscrowRelayerWorkerDatabase {
  return {
    async leaseRelayerJobs(input) {
      const jobs = await db.leaseRelayerJobs(input);
      observation.events.push('lease');
      if (jobs.some((job) => job.id !== expectedJobId)) {
        fail('dedicated database leased an unrelated relayer job');
      }
      return jobs;
    },
    async recordRelayerSignedTransaction(input) {
      observation.sequence += 1;
      observation.events.push('record_signed');
      observation.signed.push({
        jobId: input.jobId,
        rawTransactionBase64: input.rawTransactionBase64,
        expectedSignature: input.expectedSignature,
        transactionMessageHashHex: input.transactionMessageHashHex,
        lastValidBlockHeight: input.lastValidBlockHeight,
        sequence: observation.sequence,
      });
      return db.recordRelayerSignedTransaction(input);
    },
    async markRelayerSubmitted(input) {
      observation.events.push('submitted');
      return db.markRelayerSubmitted(input);
    },
    async retryRelayerJob(input) {
      observation.events.push(`retry:${input.errorCode}`);
      observation.retries.push({
        errorCode: input.errorCode,
        confirmationUnknown: input.confirmationUnknown,
        ...(input.fullHistoryCheckedAtIso === undefined ? {} : {
          fullHistoryCheckedAtIso: input.fullHistoryCheckedAtIso,
        }),
        ...(input.currentBlockHeight === undefined ? {} : {
          currentBlockHeight: input.currentBlockHeight,
        }),
      });
      return db.retryRelayerJob(input);
    },
    async completeRelayerJob(input) {
      observation.events.push('complete');
      return db.completeRelayerJob(input);
    },
    async deadLetterRelayerJob(input) {
      observation.events.push(`dead:${input.errorCode}`);
      return db.deadLetterRelayerJob(input);
    },
  };
}

interface BroadcastTrap {
  readonly raws: string[];
  firstSequence: number | null;
}

function trapBroadcast(
  chain: EscrowRelayChain,
  observation: LifecycleObservation,
  trap: BroadcastTrap,
): EscrowRelayChain {
  return {
    genesisHash: () => chain.genesisHash(),
    signatureState: (signature) => chain.signatureState(signature),
    blockHeight: () => chain.blockHeight(),
    isBlockhashValid: (blockhash) => chain.isBlockhashValid(blockhash),
    async broadcast(rawTransactionBase64) {
      observation.sequence += 1;
      trap.firstSequence ??= observation.sequence;
      trap.raws.push(rawTransactionBase64);
      throw new Error('intentional pre-network transport interruption');
    },
  };
}

export interface RecoveryEffectProbe {
  snapshot(): Promise<string>;
}

export interface DurableRelayerLifecycleOptions {
  readonly db: EscrowRelayerWorkerDatabase;
  readonly chain: EscrowRelayChain;
  readonly builder: EscrowRelayerTransactionBuilder;
  readonly finalityVerifier: EscrowRelayerFinalityVerifier;
  readonly effect: RecoveryEffectProbe;
  readonly jobId: string;
  readonly startedAt: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

export interface DurableRelayerLifecycleEvidence {
  readonly firstSignature: string;
  readonly firstRawTransactionSha256: string;
  readonly replacementSignature: string;
  readonly replacementRawTransactionSha256: string;
  readonly finalizedSlot: string;
  readonly effectBeforeSha256: string;
  readonly effectBeforeReplacementSha256: string;
  readonly effectAfterSha256: string;
  readonly actualNetworkBroadcasts: 1;
  readonly checks: readonly string[];
  readonly databaseEvents: readonly string[];
}

export async function exerciseDurableRelayerLifecycle(
  options: DurableRelayerLifecycleOptions,
): Promise<DurableRelayerLifecycleEvidence> {
  const sleep = options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const maxPolls = options.maxPolls ?? 360;
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 1) fail('maxPolls must be a positive integer');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) fail('pollIntervalMs must be a non-negative integer');
  const started = Date.parse(options.startedAt);
  if (!Number.isFinite(started)) fail('startedAt must be an ISO timestamp');
  let tick = 0;
  const now = (): string => new Date(started + tick++ * 1_000).toISOString();
  const observation: LifecycleObservation = { sequence: 0, signed: [], retries: [], events: [] };
  const db = observeDatabase(options.db, options.jobId, observation);
  const builders = Object.fromEntries(RECOVERY_KINDS.map((kind) => [kind, options.builder]));
  const finalityVerifiers = Object.fromEntries(
    RECOVERY_KINDS.map((kind) => [kind, options.finalityVerifier]),
  );
  const worker = (chain: EscrowRelayChain, workerId: string) => createEscrowRelayerWorker({
    db,
    chain,
    workerId,
    retryAt: (nowIso) => nowIso,
    positionPlacementReadiness: async () => ({ status: 'ready', reasons: [] }),
    builders,
    finalityVerifiers,
  });

  const effectBefore = await options.effect.snapshot();
  const firstTrap: BroadcastTrap = { raws: [], firstSequence: null };
  const firstResult = oneResult(await worker(
    trapBroadcast(options.chain, observation, firstTrap),
    'devnet-recovery-e2e-before-restart',
  ).runOnce(now(), 1), 'initial interrupted send');
  if (firstResult.kind !== 'retrying' || firstTrap.raws.length !== 1 || observation.signed.length !== 1) {
    fail(`initial interrupted send did not persist and classify an unknown transaction (${firstResult.kind}; traps=${firstTrap.raws.length}; signed=${observation.signed.length}; events=${observation.events.join(',')})`);
  }
  const firstSigned = observation.signed[0]!;
  if (firstTrap.firstSequence === null || firstSigned.sequence >= firstTrap.firstSequence) {
    fail('signed bytes were not durably persisted before the first broadcast attempt');
  }

  const restartTrap: BroadcastTrap = { raws: [], firstSequence: null };
  const restartResult = oneResult(await worker(
    trapBroadcast(options.chain, observation, restartTrap),
    'devnet-recovery-e2e-after-restart',
  ).runOnce(now(), 1), 'restart rebroadcast');
  if (
    restartResult.kind !== 'retrying'
    || restartTrap.raws.length !== 1
    || restartTrap.raws[0] !== firstSigned.rawTransactionBase64
    || observation.signed.length !== 1
  ) fail('restart did not rebroadcast the exact persisted bytes without rebuilding');

  const firstBlockhash = transactionBlockhash(firstSigned.rawTransactionBase64);
  let expiredHeight: bigint | null = null;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const state = await options.chain.signatureState(firstSigned.expectedSignature);
    if (state.kind !== 'absent') fail('the intentionally unsent persisted signature appeared in full history');
    const [valid, height] = await Promise.all([
      options.chain.isBlockhashValid(firstBlockhash),
      options.chain.blockHeight(),
    ]);
    if (!valid && height > firstSigned.lastValidBlockHeight) {
      expiredHeight = height;
      break;
    }
    await sleep(pollIntervalMs);
  }
  if (expiredHeight === null) fail('timed out waiting for the persisted blockhash to expire');

  const retriesBeforeExpiry = observation.retries.length;
  const expiryResult = oneResult(await worker(
    options.chain,
    'devnet-recovery-e2e-expiry-history-check',
  ).runOnce(now(), 1), 'expired history check');
  const expiryRetry = observation.retries.at(-1);
  if (
    expiryResult.kind !== 'retrying'
    || observation.retries.length !== retriesBeforeExpiry + 1
    || expiryRetry?.errorCode !== 'expired_not_landed'
    || expiryRetry.confirmationUnknown
    || expiryRetry.fullHistoryCheckedAtIso === null
    || expiryRetry.fullHistoryCheckedAtIso === undefined
    || expiryRetry.currentBlockHeight === null
    || expiryRetry.currentBlockHeight === undefined
    || expiryRetry.currentBlockHeight <= firstSigned.lastValidBlockHeight
  ) fail('expired full-history absence did not authorize the safe re-sign transition');

  const effectBeforeReplacement = await options.effect.snapshot();
  if (effectBeforeReplacement !== effectBefore) {
    fail('an on-chain effect occurred before the replacement transaction was authorized');
  }

  const actualBroadcasts: string[] = [];
  const actualChain: EscrowRelayChain = {
    genesisHash: () => options.chain.genesisHash(),
    signatureState: (signature) => options.chain.signatureState(signature),
    blockHeight: () => options.chain.blockHeight(),
    isBlockhashValid: (blockhash) => options.chain.isBlockhashValid(blockhash),
    async broadcast(rawTransactionBase64) {
      actualBroadcasts.push(rawTransactionBase64);
      return options.chain.broadcast(rawTransactionBase64);
    },
  };
  const replacementResult = oneResult(await worker(
    actualChain,
    'devnet-recovery-e2e-replacement',
  ).runOnce(now(), 1), 'replacement send');
  const replacement = observation.signed[1];
  if (replacementResult.kind !== 'submitted' || replacement === undefined || actualBroadcasts.length !== 1) {
    fail('replacement transaction was not signed, persisted, and submitted exactly once');
  }
  if (
    replacement.rawTransactionBase64 === firstSigned.rawTransactionBase64
    || replacement.expectedSignature === firstSigned.expectedSignature
  ) fail('safe re-sign did not produce replacement bytes and a replacement signature');

  let finalizedSlot: bigint | null = null;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const state = await options.chain.signatureState(replacement.expectedSignature);
    if (state.kind === 'failed') fail(`replacement transaction failed: ${state.errorCode}`);
    if (state.kind === 'finalized') {
      finalizedSlot = state.slot;
      break;
    }
    await sleep(pollIntervalMs);
  }
  if (finalizedSlot === null) fail('timed out waiting for replacement transaction finality');

  const completion = oneResult(await worker(
    actualChain,
    'devnet-recovery-e2e-finality',
  ).runOnce(now(), 1), 'finalized effect verification');
  if (completion.kind !== 'complete') fail('finalized signature did not verify the expected on-chain effect');
  const effectAfter = await options.effect.snapshot();
  if (effectAfter === effectBefore) fail('finality verifier completed without an observable account effect');

  const noOp = await worker(actualChain, 'devnet-recovery-e2e-post-completion').runOnce(now(), 1);
  const effectAfterNoOp = await options.effect.snapshot();
  if (noOp.length !== 0 || actualBroadcasts.length !== 1 || effectAfterNoOp !== effectAfter) {
    fail('completed recovery was not exactly-once under a post-completion worker cycle');
  }

  return {
    firstSignature: firstSigned.expectedSignature,
    firstRawTransactionSha256: sha256(Buffer.from(firstSigned.rawTransactionBase64, 'base64')),
    replacementSignature: replacement.expectedSignature,
    replacementRawTransactionSha256: sha256(Buffer.from(replacement.rawTransactionBase64, 'base64')),
    finalizedSlot: String(finalizedSlot),
    effectBeforeSha256: effectBefore,
    effectBeforeReplacementSha256: effectBeforeReplacement,
    effectAfterSha256: effectAfter,
    actualNetworkBroadcasts: 1,
    checks: [
      'signed bytes persisted before first broadcast attempt',
      'fresh worker rebroadcast exact persisted bytes without rebuilding',
      'unknown confirmation retained signed bytes',
      'full-history absence plus expired blockhash authorized safe re-sign',
      'replacement transaction finalized with the expected on-chain effect',
      'post-completion worker cycle produced no second effect or broadcast',
    ],
    databaseEvents: observation.events,
  };
}

function accountDigest(
  account: Awaited<ReturnType<SolanaEscrowAccountReader['raw']>>,
): Record<string, unknown> | null {
  if (account === null) return null;
  return {
    address: account.address,
    ownerProgramId: account.ownerProgramId,
    lamports: String(account.lamports),
    dataSha256: sha256(account.value),
  };
}

function createEffectProbe(
  accounts: SolanaEscrowAccountReader,
  programId: string,
  request: EscrowRecoveryRequest,
): RecoveryEffectProbe {
  const addresses = [request.marketPda];
  if ('owner' in request) {
    addresses.push(deriveUserPositionPda(programId, request.marketPda, request.owner).address);
    if (request.operation === 'close_position_lots') {
      addresses.push(...request.lotNonces.map((nonce) => derivePositionLotPda(
        programId,
        request.marketPda,
        request.owner,
        nonce,
      ).address));
    }
  }
  return {
    async snapshot() {
      const values = await Promise.all(addresses.map((address) => accounts.raw(address)));
      return sha256(stableJson(values.map(accountDigest)));
    },
  };
}

function activeBacklog(backlog: Awaited<ReturnType<ReturnType<typeof createEscrowDb>['relayerBacklog']>>): number {
  return backlog.readyCount + backlog.leasedCount + backlog.unknownCount + backlog.submittedCount;
}

export interface DevnetRelayerRecoveryPreflightEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'devnet-relayer-recovery-preflight';
  readonly mode: 'dry-run';
  readonly releaseIdentity: ReleaseIdentity;
  readonly requestSha256: string;
  readonly checkedAt: string;
  readonly checks: readonly string[];
}

export interface DevnetRelayerRecoveryExecutionEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'devnet-relayer-recovery-e2e';
  readonly mode: 'execute';
  readonly releaseIdentity: ReleaseIdentity;
  readonly requestSha256: string;
  readonly jobId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly lifecycle: DurableRelayerLifecycleEvidence;
}

export interface RunDevnetRelayerRecoveryOptions {
  readonly mode: 'dry-run' | 'execute';
  readonly manifest: ReleaseManifest;
  readonly request: EscrowRecoveryRequest;
  readonly requestSha256: string;
  readonly rpcUrl: string;
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly sponsor: Keypair;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

export async function runDevnetRelayerRecovery(
  options: RunDevnetRelayerRecoveryOptions,
): Promise<DevnetRelayerRecoveryPreflightEvidence | DevnetRelayerRecoveryExecutionEvidence> {
  const manifest = validateDevnetManifest(parseReleaseManifest(options.manifest));
  const rpcUrl = assertHttpUrl(options.rpcUrl, 'ESCROW_RELAYER_RECOVERY_RPC_URL');
  assertHttpUrl(options.supabaseUrl, 'ESCROW_RELAYER_RECOVERY_SUPABASE_URL');
  if (options.sponsor.publicKey.toBase58() !== manifest.config.relayerFeePayer) {
    fail('fee-payer credential does not match the release manifest');
  }
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  if (Number.isNaN(Date.parse(checkedAt))) fail('clock returned an invalid timestamp');
  const deploymentChecks = await verifyDevnetDeployment(
    manifest,
    new JsonRpcReader(rpcUrl),
  );
  const db = createEscrowDb(options.supabaseUrl, options.serviceRoleKey);
  const backlog = await db.relayerBacklog(checkedAt);
  if (activeBacklog(backlog) !== 0) fail('dedicated database has active relayer work; refusing to lease or enqueue');
  const link = await db.getMarketLink({
    cluster: 'devnet',
    genesisHash: manifest.clusterGenesisHash,
    programId: manifest.programId,
    marketPda: options.request.marketPda,
  });
  if (
    !link.ok || !link.found || link.custodyVersion !== manifest.config.custodyVersion
    || link.commitment !== 'finalized' || link.projectionStale
  ) fail('request market is not a finalized release-bound database projection');

  const identity = releaseIdentity(manifest);
  const preflightChecks = [
    ...deploymentChecks,
    'fee payer matches release manifest',
    'database relayer queue is idle',
    'request market projection is finalized and release-bound',
    'dry-run submitted zero transactions and performed zero database mutations',
  ];
  if (options.mode === 'dry-run') {
    return {
      schemaVersion: 1,
      kind: 'devnet-relayer-recovery-preflight',
      mode: 'dry-run',
      releaseIdentity: identity,
      requestSha256: options.requestSha256,
      checkedAt,
      checks: preflightChecks,
    };
  }

  const deployment: EscrowRecoveryDeployment = {
    cluster: 'devnet',
    genesisHash: manifest.clusterGenesisHash,
    programId: manifest.programId,
    canonicalUsdcMint: manifest.config.canonicalUsdcMint,
    relayerFeePayer: manifest.config.relayerFeePayer,
    residualRecipient: manifest.config.residualRecipient,
    custodyVersion: manifest.config.custodyVersion,
  };
  const service = createEscrowRecoveryService({
    db,
    deployment,
    readiness: async () => ({ status: 'ready', reasons: [] }),
    clock: () => checkedAt,
  });
  const enqueued = await service.enqueue(options.request);
  if (enqueued.kind !== 'enqueued' || !enqueued.created) {
    fail('recovery request did not create a fresh durable relayer job');
  }
  const rpc = createEscrowSolanaRpc(rpcUrl);
  const accounts = new SolanaEscrowAccountReader(rpc.connection);
  const recoveryChain = new SolanaEscrowRecoveryChain(rpc, accounts);
  const builder = createEscrowRecoveryTransactionBuilder({
    db,
    chain: recoveryChain,
    sponsor: options.sponsor,
    deployment,
  });
  const finalityVerifier = createEscrowRecoveryFinalityVerifier({
    chain: recoveryChain,
    programId: manifest.programId,
  });
  const lifecycle = await exerciseDurableRelayerLifecycle({
    db,
    chain: rpc,
    builder,
    finalityVerifier,
    effect: createEffectProbe(accounts, manifest.programId, options.request),
    jobId: enqueued.jobId,
    startedAt: checkedAt,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.maxPolls === undefined ? {} : { maxPolls: options.maxPolls }),
  });
  const completedAt = now().toISOString();
  return {
    schemaVersion: 1,
    kind: 'devnet-relayer-recovery-e2e',
    mode: 'execute',
    releaseIdentity: identity,
    requestSha256: options.requestSha256,
    jobId: enqueued.jobId,
    startedAt: checkedAt,
    completedAt,
    lifecycle,
  };
}

interface CliOptions {
  readonly manifestPath: string;
  readonly requestPath: string;
  readonly outputPath?: string;
  readonly execute: boolean;
}

export function parseCliArgs(args: readonly string[]): CliOptions {
  let manifestPath: string | undefined;
  let requestPath: string | undefined;
  let outputPath: string | undefined;
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--execute') {
      if (execute) fail('duplicate --execute option');
      execute = true;
      continue;
    }
    if (argument !== '--manifest' && argument !== '--request' && argument !== '--out') {
      fail('unknown option; use --help for the supported interface');
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${argument} requires a value`);
    index += 1;
    if (argument === '--manifest') {
      if (manifestPath !== undefined) fail('duplicate --manifest option');
      manifestPath = value;
    } else if (argument === '--request') {
      if (requestPath !== undefined) fail('duplicate --request option');
      requestPath = value;
    } else {
      if (outputPath !== undefined) fail('duplicate --out option');
      outputPath = value;
    }
  }
  if (manifestPath === undefined || requestPath === undefined) fail('--manifest and --request are required');
  if (execute && outputPath === undefined) fail('execute mode requires --out');
  return {
    manifestPath,
    requestPath,
    ...(outputPath === undefined ? {} : { outputPath }),
    execute,
  };
}

async function emitEvidence(value: unknown, outputPath?: string): Promise<void> {
  const rendered = stableJson(value);
  if (outputPath === undefined) {
    process.stdout.write(rendered);
    return;
  }
  await writeFile(outputPath, rendered, { encoding: 'utf8', flag: 'wx', mode: 0o644 }).catch(() => {
    fail('refusing to overwrite or unable to create the requested evidence file');
  });
}

export async function runCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const cli = parseCliArgs(args);
    if (cli.execute) assertLiveExecutionEnabled(environment);
    const [manifestValue, requestValue] = await Promise.all([
      readJson(cli.manifestPath),
      readJson(cli.requestPath),
    ]);
    const manifest = parseReleaseManifest(manifestValue);
    const request = parseRecoveryRequest(requestValue);
    const rpcUrl = assertHttpUrl(requiredEnvironment(
      environment,
      'ESCROW_RELAYER_RECOVERY_RPC_URL',
    ), 'ESCROW_RELAYER_RECOVERY_RPC_URL');
    const supabaseUrl = assertHttpUrl(requiredEnvironment(
      environment,
      'ESCROW_RELAYER_RECOVERY_SUPABASE_URL',
    ), 'ESCROW_RELAYER_RECOVERY_SUPABASE_URL');
    const serviceRoleKey = requiredEnvironment(
      environment,
      'ESCROW_RELAYER_RECOVERY_SUPABASE_SERVICE_ROLE_KEY',
    );
    const sponsor = await loadFeePayer(requiredEnvironment(
      environment,
      'ESCROW_RELAYER_RECOVERY_FEE_PAYER_KEYPAIR_PATH',
    ));
    const result = await runDevnetRelayerRecovery({
      mode: cli.execute ? 'execute' : 'dry-run',
      manifest,
      request,
      requestSha256: sha256(stableJson(requestValue)),
      rpcUrl,
      supabaseUrl,
      serviceRoleKey,
      sponsor,
    });
    await emitEvidence(result, cli.outputPath);
    return 0;
  } catch (error) {
    const message = error instanceof DevnetRelayerRecoveryE2eError
      ? error.message
      : 'devnet relayer recovery harness failed without exposing credentials or RPC details';
    process.stderr.write(`devnet relayer recovery harness: ${message}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
