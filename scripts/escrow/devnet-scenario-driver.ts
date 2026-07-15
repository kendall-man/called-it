import { createHash, createPrivateKey, sign as signEd25519 } from 'node:crypto';

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  type Signer,
  type TransactionInstruction,
} from '@solana/web3.js';

import {
  POSITION_ACTIVATION_DELAY_SECONDS_V1,
  buildAttestationVerificationInstructions,
  buildPositionInstruction,
  buildUnsignedV0Transaction,
  decodeMarketAccount,
  decodeProtocolConfigAccount,
  decodeUserPositionAccount,
  deriveClassicAssociatedTokenAddress,
  deriveMarketPda,
  deriveUserPositionPda,
  encodeSettlementAttestationV1,
  hashMarketDocumentV1,
  materializeInstruction,
  ratioMilliFromProbabilityPpm,
  type EscrowAsset,
  type MarketDocumentV1,
  type SettlementAttestationV1,
} from '../../packages/escrow-sdk/src/index.js';
import {
  DEVNET_GENESIS_HASH,
  PINNED_ESCROW_PROGRAM_ID,
} from './devnet-bootstrap.js';
import type {
  DevnetScenarioContext,
  DevnetScenarioDriver,
} from './devnet-evidence-runner.js';
import type { DevnetScenario } from './evidence.js';
import type { ReleaseManifest } from './types.js';
import { encodeBase58 } from './util.js';

const CONFIRMATION_COMMITMENT = 'finalized' as const;
const NORMAL_CUTOFF_SECONDS = 90;
const NORMAL_RESOLUTION_SECONDS = 3;
const TIMEOUT_CUTOFF_SECONDS = 90;
const TIMEOUT_RESOLUTION_SECONDS = 3;
const ATTESTATION_LIFETIME_SECONDS = 5 * 60;
const MAX_TIMEOUT_WAIT_MS = 3 * 60 * 1_000;
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const TOKEN_ACCOUNT_STATE_OFFSET = 108;
const TOKEN_ACCOUNT_SIZE = 165;
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class DevnetScenarioDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevnetScenarioDriverError';
  }
}

export interface DevnetScenarioAccount {
  readonly owner: string;
  readonly data: Uint8Array;
}

export interface DevnetScenarioBlockhash {
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

export interface DevnetScenarioTransport {
  genesisHash(): Promise<string>;
  unixTime(): Promise<number>;
  latestBlockhash(): Promise<DevnetScenarioBlockhash>;
  account(address: string): Promise<DevnetScenarioAccount | null>;
  sendRawTransaction(rawTransaction: Uint8Array, options?: { readonly skipPreflight?: boolean }): Promise<string>;
  confirmFinalized(input: DevnetScenarioBlockhash & { readonly signature: string }): Promise<void>;
  isFinalized(signature: string): Promise<boolean>;
  sleep(milliseconds: number): Promise<void>;
}

export interface CreateDevnetScenarioDriverOptions {
  readonly transportFactory?: (context: DevnetScenarioContext) => DevnetScenarioTransport;
}

interface SubmittedTransaction {
  readonly signature: string;
  readonly rawTransaction: Uint8Array;
  readonly blockhash: DevnetScenarioBlockhash;
}

export interface ScenarioMarket {
  readonly document: MarketDocumentV1;
  readonly documentHash: Uint8Array;
  readonly marketPda: PublicKey;
}

interface DriverSession {
  readonly identity: string;
  readonly transport: DevnetScenarioTransport;
  readonly pendingMarkets: Map<string, PendingScenarioMarket>;
}

export interface PendingScenarioMarket {
  readonly market: ScenarioMarket;
  readonly owner: Keypair;
}

function fail(message: string): never {
  throw new DevnetScenarioDriverError(message);
}

function assertExactDevnetManifest(manifest: ReleaseManifest): void {
  if (manifest.network !== 'devnet') fail('scenario driver refuses every non-devnet manifest');
  if (manifest.clusterGenesisHash !== DEVNET_GENESIS_HASH) fail('scenario driver requires the exact Solana devnet genesis');
  if (manifest.programId !== PINNED_ESCROW_PROGRAM_ID) fail('scenario driver requires the repository-pinned devnet program');
}

async function assertExactDevnet(transport: DevnetScenarioTransport, manifest: ReleaseManifest): Promise<void> {
  const genesis = await transport.genesisHash().catch(() => fail('devnet genesis check failed before a transaction-capable step'));
  if (genesis !== DEVNET_GENESIS_HASH || genesis !== manifest.clusterGenesisHash) {
    fail('RPC is not the exact Solana devnet cluster; refusing transaction construction');
  }
}

function connectionTransport(rpcUrl: string): DevnetScenarioTransport {
  const connection = new Connection(rpcUrl, CONFIRMATION_COMMITMENT);
  return {
    async genesisHash() {
      return connection.getGenesisHash();
    },
    async unixTime() {
      const slot = await connection.getSlot(CONFIRMATION_COMMITMENT);
      const blockTime = await connection.getBlockTime(slot);
      if (blockTime === null) fail('finalized devnet block time is unavailable');
      return blockTime;
    },
    async latestBlockhash() {
      return connection.getLatestBlockhash(CONFIRMATION_COMMITMENT);
    },
    async account(address) {
      const account = await connection.getAccountInfo(new PublicKey(address), CONFIRMATION_COMMITMENT);
      return account === null
        ? null
        : { owner: account.owner.toBase58(), data: Uint8Array.from(account.data) };
    },
    async sendRawTransaction(rawTransaction, options) {
      return connection.sendRawTransaction(Buffer.from(rawTransaction), {
        maxRetries: 3,
        preflightCommitment: CONFIRMATION_COMMITMENT,
        skipPreflight: options?.skipPreflight ?? false,
      });
    },
    async confirmFinalized(input) {
      const confirmation = await connection.confirmTransaction({
        signature: input.signature,
        blockhash: input.blockhash,
        lastValidBlockHeight: input.lastValidBlockHeight,
      }, CONFIRMATION_COMMITMENT);
      if (confirmation.value.err !== null) fail('devnet transaction failed before finalization');
      const status = (await connection.getSignatureStatuses([input.signature], {
        searchTransactionHistory: true,
      })).value[0];
      if (status == null || status.err !== null || status.confirmationStatus !== 'finalized') {
        fail('devnet transaction did not reach successful finalized status');
      }
    },
    async isFinalized(signature) {
      const status = (await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })).value[0];
      return status != null && status.err === null && status.confirmationStatus === 'finalized';
    },
    async sleep(milliseconds) {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    },
  };
}

function sha256(...parts: readonly (string | Uint8Array)[]): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function deterministicUuid(runId: string, scenario: DevnetScenario['id']): string {
  const bytes = Uint8Array.from(sha256('calledit.devnet-e2e.market.v1', runId, scenario).subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fixtureId(runId: string, scenario: DevnetScenario['id']): bigint {
  return Buffer.from(sha256('calledit.devnet-e2e.fixture.v1', runId, scenario).subarray(0, 8)).readBigUInt64LE();
}

function transactionSignature(transaction: VersionedTransaction): string {
  const signature = transaction.signatures[0];
  if (signature === undefined || signature.every((byte) => byte === 0)) fail('fee payer did not sign the transaction');
  return encodeBase58(signature);
}

function uniqueSigners(signers: readonly Signer[]): readonly Signer[] {
  const seen = new Set<string>();
  return signers.filter((signer) => {
    const address = signer.publicKey.toBase58();
    if (seen.has(address)) return false;
    seen.add(address);
    return true;
  });
}

async function buildSignedTransaction(input: {
  readonly context: DevnetScenarioContext;
  readonly transport: DevnetScenarioTransport;
  readonly feePayer: PublicKey;
  readonly instructions: readonly TransactionInstruction[];
  readonly signers: readonly Signer[];
}): Promise<SubmittedTransaction> {
  await assertExactDevnet(input.transport, input.context.manifest);
  const blockhash = await input.transport.latestBlockhash();
  await assertExactDevnet(input.transport, input.context.manifest);
  const transaction = buildUnsignedV0Transaction({
    feePayer: input.feePayer,
    recentBlockhash: blockhash.blockhash,
    instructions: input.instructions,
  });
  transaction.sign([...uniqueSigners(input.signers)]);
  return {
    signature: transactionSignature(transaction),
    rawTransaction: transaction.serialize(),
    blockhash,
  };
}

async function broadcastFinalized(
  context: DevnetScenarioContext,
  transport: DevnetScenarioTransport,
  transaction: SubmittedTransaction,
): Promise<string> {
  await assertExactDevnet(transport, context.manifest);
  const submitted = await transport.sendRawTransaction(transaction.rawTransaction);
  if (submitted !== transaction.signature) fail('RPC returned a signature that does not match the signed transaction');
  await transport.confirmFinalized({ ...transaction.blockhash, signature: transaction.signature });
  await assertExactDevnet(transport, context.manifest);
  return transaction.signature;
}

async function submitInstructions(input: {
  readonly context: DevnetScenarioContext;
  readonly transport: DevnetScenarioTransport;
  readonly feePayer: PublicKey;
  readonly instructions: readonly TransactionInstruction[];
  readonly signers: readonly Signer[];
}): Promise<SubmittedTransaction> {
  const transaction = await buildSignedTransaction(input);
  await broadcastFinalized(input.context, input.transport, transaction);
  return transaction;
}

function marketDocument(input: {
  readonly context: DevnetScenarioContext;
  readonly scenario: DevnetScenario['id'];
  readonly asset: EscrowAsset;
  readonly now: number;
  readonly timeout?: boolean;
  readonly replay?: boolean;
}): MarketDocumentV1 {
  const probabilityPpm = 500_000;
  const cutoff = input.now + (input.timeout === true ? TIMEOUT_CUTOFF_SECONDS : NORMAL_CUTOFF_SECONDS);
  return {
    marketUuid: deterministicUuid(input.context.runId, input.scenario),
    fixtureId: fixtureId(input.context.runId, input.scenario),
    claimSpecificationHash: sha256('calledit.devnet-e2e.claim.v1', input.context.runId, input.scenario),
    displayTermsHash: sha256('calledit.devnet-e2e.display.v1', input.context.runId, input.scenario),
    asset: input.asset,
    probabilityPpm,
    ratioMilli: ratioMilliFromProbabilityPpm(probabilityPpm),
    oddsMessageHash: sha256('calledit.devnet-e2e.odds.v1', input.context.runId, input.scenario),
    oddsTimestamp: BigInt(input.now - 1),
    inPlayStartTimestamp: BigInt(cutoff - 1),
    activationDelaySeconds: POSITION_ACTIVATION_DELAY_SECONDS_V1,
    positionCutoff: BigInt(cutoff),
    resolutionDeadline: BigInt(cutoff + (input.timeout === true ? TIMEOUT_RESOLUTION_SECONDS : NORMAL_RESOLUTION_SECONDS)),
    feeBps: 0,
    oracleSetEpoch: BigInt(input.context.manifest.oracleSet.epoch),
    replayFlag: input.replay ?? false,
  };
}

async function initializeMarket(input: {
  readonly context: DevnetScenarioContext;
  readonly transport: DevnetScenarioTransport;
  readonly scenario: DevnetScenario['id'];
  readonly asset: EscrowAsset;
  readonly timeout?: boolean;
  readonly replay?: boolean;
}): Promise<ScenarioMarket> {
  const now = await input.transport.unixTime();
  const document = marketDocument({ ...input, now });
  const documentHash = hashMarketDocumentV1(document);
  const programId = new PublicKey(input.context.manifest.programId);
  const instruction = materializeInstruction({
    kind: 'initialize_market',
    payer: input.context.credentials.relayerFeePayer.publicKey,
    marketCreationAuthority: input.context.credentials.marketCreationAuthority.publicKey,
    canonicalUsdcMint: input.context.manifest.config.canonicalUsdcMint,
    expectedClusterGenesisHash: new PublicKey(input.context.manifest.clusterGenesisHash).toBytes(),
    document,
    documentHash,
  }, { programId });
  await submitInstructions({
    context: input.context,
    transport: input.transport,
    feePayer: input.context.credentials.relayerFeePayer.publicKey,
    instructions: [instruction],
    signers: [input.context.credentials.relayerFeePayer, input.context.credentials.marketCreationAuthority],
  });
  return { document, documentHash, marketPda: deriveMarketPda(programId, document.marketUuid).publicKey };
}

function amountFor(manifest: ReleaseManifest, asset: EscrowAsset): bigint {
  const amount = BigInt(asset === 'sol' ? manifest.config.minSolPosition : manifest.config.minUsdcPosition);
  if (amount <= 0n) fail(`manifest minimum ${asset.toUpperCase()} position must be positive`);
  return amount;
}

async function assertUsdcFunding(
  context: DevnetScenarioContext,
  transport: DevnetScenarioTransport,
  owner: PublicKey,
  amount: bigint,
): Promise<void> {
  const mint = new PublicKey(context.manifest.config.canonicalUsdcMint);
  const source = deriveClassicAssociatedTokenAddress(owner, mint);
  const account = await transport.account(source.toBase58());
  if (account === null || account.owner !== context.manifest.config.allowedTokenProgram || account.data.length < TOKEN_ACCOUNT_SIZE) {
    fail('USDC scenario wallet has no canonical classic-token devnet USDC account');
  }
  const data = Buffer.from(account.data);
  if (data[TOKEN_ACCOUNT_STATE_OFFSET] !== 1) fail('USDC scenario wallet token account is not initialized');
  if (!data.subarray(0, 32).equals(mint.toBuffer())) fail('USDC scenario wallet token account uses the wrong mint');
  if (!data.subarray(32, 64).equals(owner.toBuffer())) fail('USDC scenario wallet token account uses the wrong owner');
  if (data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET) < amount) fail('USDC scenario wallet has insufficient canonical devnet USDC');
}

async function placePosition(input: {
  readonly context: DevnetScenarioContext;
  readonly transport: DevnetScenarioTransport;
  readonly market: ScenarioMarket;
  readonly owner: Keypair;
  readonly side?: 'back' | 'doubt';
}): Promise<SubmittedTransaction> {
  const now = await input.transport.unixTime();
  const amount = amountFor(input.context.manifest, input.market.document.asset);
  if (input.market.document.asset === 'usdc') {
    await assertUsdcFunding(input.context, input.transport, input.owner.publicKey, amount);
  }
  const expiresAt = BigInt(Math.min(now + 5 * 60, Number(input.market.document.positionCutoff)));
  const built = buildPositionInstruction({
    programId: input.context.manifest.programId,
    relayerFeePayer: input.context.credentials.relayerFeePayer.publicKey,
    userWallet: input.owner.publicKey,
    canonicalUsdcMint: input.context.manifest.config.canonicalUsdcMint,
    marketUuid: input.market.document.marketUuid,
    marketDocumentHash: input.market.documentHash,
    side: input.side ?? 'back',
    amount,
    asset: input.market.document.asset,
    expectedRatioMilli: input.market.document.ratioMilli,
    expectedEventEpoch: 0n,
    expectedLotNonce: 0n,
    expiresAt,
  });
  return submitInstructions({
    context: input.context,
    transport: input.transport,
    feePayer: input.context.credentials.relayerFeePayer.publicKey,
    instructions: [built.instruction],
    signers: [input.context.credentials.relayerFeePayer, input.owner],
  });
}

function signAttestation(message: Uint8Array, signer: Keypair): Uint8Array {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, Buffer.from(signer.secretKey.subarray(0, 32))]),
    format: 'der',
    type: 'pkcs8',
  });
  return Uint8Array.from(signEd25519(null, Buffer.from(message), privateKey));
}

async function settleMarket(input: {
  readonly context: DevnetScenarioContext;
  readonly transport: DevnetScenarioTransport;
  readonly market: ScenarioMarket;
}): Promise<SubmittedTransaction> {
  const now = await input.transport.unixTime();
  const programId = new PublicKey(input.context.manifest.programId);
  const evidenceHash = sha256('calledit.devnet-e2e.settlement.v1', input.context.runId, input.market.document.marketUuid);
  const attestation: SettlementAttestationV1 = {
    clusterGenesisHash: new PublicKey(input.context.manifest.clusterGenesisHash).toBytes(),
    escrowProgramId: programId.toBytes(),
    marketPda: input.market.marketPda.toBytes(),
    marketDocumentHash: input.market.documentHash,
    fixtureId: input.market.document.fixtureId,
    oracleSetEpoch: input.market.document.oracleSetEpoch,
    issuedAt: BigInt(now),
    expiresAt: BigInt(now + ATTESTATION_LIFETIME_SECONDS),
    evidenceHash,
    outcome: 'claim_won',
    decidingSequence: 1n,
    terminalPhase: 'F',
    regulationScore: { home: 1, away: 0 },
    fullMatchScore: { home: 1, away: 0 },
    evidenceSequenceCommitment: sha256('calledit.devnet-e2e.sequence.v1', input.market.document.marketUuid),
    normalizedEvidenceRoot: sha256('calledit.devnet-e2e.root.v1', input.market.document.marketUuid),
  };
  const message = encodeSettlementAttestationV1(attestation);
  const signatures = input.context.credentials.oracleSigners.map((signer) => ({
    publicKey: signer.publicKey.toBytes(),
    signature: signAttestation(message, signer),
  }));
  const verification = buildAttestationVerificationInstructions(message, signatures);
  const settlement = materializeInstruction({
    kind: 'settle_market',
    marketUuid: input.market.document.marketUuid,
    attestation,
  }, { programId });
  return submitInstructions({
    context: input.context,
    transport: input.transport,
    feePayer: input.context.credentials.relayerFeePayer.publicKey,
    instructions: [...verification, settlement],
    signers: [input.context.credentials.relayerFeePayer],
  });
}

async function calculateAndClaim(input: {
  readonly context: DevnetScenarioContext;
  readonly transport: DevnetScenarioTransport;
  readonly market: ScenarioMarket;
  readonly owner: Keypair;
  readonly direct: boolean;
}): Promise<SubmittedTransaction> {
  const programId = new PublicKey(input.context.manifest.programId);
  const calculate = materializeInstruction({
    kind: 'calculate_position_entitlement',
    marketUuid: input.market.document.marketUuid,
    owner: input.owner.publicKey,
  }, { programId });
  const claim = input.direct
    ? materializeInstruction({
      kind: 'claim_position',
      marketUuid: input.market.document.marketUuid,
      owner: input.owner.publicKey,
      asset: input.market.document.asset,
      canonicalUsdcMint: input.context.manifest.config.canonicalUsdcMint,
    }, { programId })
    : materializeInstruction({
      kind: 'claim_position_for',
      payer: input.context.credentials.relayerFeePayer.publicKey,
      marketUuid: input.market.document.marketUuid,
      owner: input.owner.publicKey,
      asset: input.market.document.asset,
      canonicalUsdcMint: input.context.manifest.config.canonicalUsdcMint,
    }, { programId });
  const feePayer = input.direct ? input.owner : input.context.credentials.relayerFeePayer;
  return submitInstructions({
    context: input.context,
    transport: input.transport,
    feePayer: feePayer.publicKey,
    instructions: [calculate, claim],
    signers: [feePayer],
  });
}

async function claimOnly(input: {
  readonly context: DevnetScenarioContext;
  readonly transport: DevnetScenarioTransport;
  readonly market: ScenarioMarket;
  readonly owner: Keypair;
}): Promise<SubmittedTransaction> {
  const programId = new PublicKey(input.context.manifest.programId);
  const claim = materializeInstruction({
    kind: 'claim_position_for',
    payer: input.context.credentials.relayerFeePayer.publicKey,
    marketUuid: input.market.document.marketUuid,
    owner: input.owner.publicKey,
    asset: input.market.document.asset,
    canonicalUsdcMint: input.context.manifest.config.canonicalUsdcMint,
  }, { programId });
  return submitInstructions({
    context: input.context,
    transport: input.transport,
    feePayer: input.context.credentials.relayerFeePayer.publicKey,
    instructions: [claim],
    signers: [input.context.credentials.relayerFeePayer],
  });
}

async function setPause(input: {
  readonly context: DevnetScenarioContext;
  readonly transport: DevnetScenarioTransport;
  readonly authority: Keypair;
  readonly paused: boolean;
}): Promise<SubmittedTransaction> {
  const instruction = materializeInstruction({
    kind: 'set_pause',
    authority: input.authority.publicKey,
    paused: input.paused,
  }, { programId: new PublicKey(input.context.manifest.programId) });
  return submitInstructions({
    context: input.context,
    transport: input.transport,
    feePayer: input.context.credentials.relayerFeePayer.publicKey,
    instructions: [instruction],
    signers: [input.context.credentials.relayerFeePayer, input.authority],
  });
}

async function protocolPaused(context: DevnetScenarioContext, transport: DevnetScenarioTransport): Promise<boolean> {
  const account = await transport.account(context.manifest.configPda);
  if (account === null || account.owner !== context.manifest.programId) fail('protocol config account is unavailable during baseline restoration');
  return decodeProtocolConfigAccount(account.data).paused;
}

async function waitPastDeadline(
  context: DevnetScenarioContext,
  transport: DevnetScenarioTransport,
  deadline: bigint,
): Promise<void> {
  const started = Date.now();
  while (BigInt(await transport.unixTime()) <= deadline) {
    if (Date.now() - started > MAX_TIMEOUT_WAIT_MS) fail('timed out waiting for the immutable timeout-void deadline');
    await assertExactDevnet(transport, context.manifest);
    await transport.sleep(1_000);
  }
}

async function timeoutAndClaim(input: {
  readonly context: DevnetScenarioContext;
  readonly transport: DevnetScenarioTransport;
  readonly market: ScenarioMarket;
  readonly owner: Keypair;
}): Promise<SubmittedTransaction> {
  const programId = new PublicKey(input.context.manifest.programId);
  const timeout = materializeInstruction({
    kind: 'timeout_void',
    marketUuid: input.market.document.marketUuid,
  }, { programId });
  const claim = materializeInstruction({
    kind: 'claim_position_for',
    payer: input.context.credentials.relayerFeePayer.publicKey,
    marketUuid: input.market.document.marketUuid,
    owner: input.owner.publicKey,
    asset: input.market.document.asset,
    canonicalUsdcMint: input.context.manifest.config.canonicalUsdcMint,
  }, { programId });
  return submitInstructions({
    context: input.context,
    transport: input.transport,
    feePayer: input.context.credentials.relayerFeePayer.publicKey,
    instructions: [timeout, claim],
    signers: [input.context.credentials.relayerFeePayer],
  });
}

async function replayFinalizedRaw(
  context: DevnetScenarioContext,
  transport: DevnetScenarioTransport,
  transaction: SubmittedTransaction,
): Promise<void> {
  await assertExactDevnet(transport, context.manifest);
  try {
    const replaySignature = await transport.sendRawTransaction(transaction.rawTransaction, { skipPreflight: true });
    if (replaySignature !== transaction.signature) fail('idempotent retry changed the transaction signature');
  } catch (error) {
    if (!await transport.isFinalized(transaction.signature)) throw error;
  }
  if (!await transport.isFinalized(transaction.signature)) fail('idempotent retry lost the finalized placement');
}

async function runBasicPosition(input: {
  readonly context: DevnetScenarioContext;
  readonly session: DriverSession;
  readonly scenario: DevnetScenario['id'];
  readonly asset: EscrowAsset;
  readonly owner: Keypair;
  readonly timeout?: boolean;
  readonly replay?: boolean;
}): Promise<{ readonly market: ScenarioMarket; readonly placement: SubmittedTransaction }> {
  const market = await initializeMarket({ ...input, transport: input.session.transport });
  const placement = await placePosition({ ...input, transport: input.session.transport, market });
  input.session.pendingMarkets.set(market.marketPda.toBase58(), { market, owner: input.owner });
  return { market, placement };
}

function markRecovered(session: DriverSession, market: ScenarioMarket): void {
  session.pendingMarkets.delete(market.marketPda.toBase58());
}

export async function recoverPendingDevnetScenarioMarket(input: {
  readonly context: DevnetScenarioContext;
  readonly transport: DevnetScenarioTransport;
  readonly pending: PendingScenarioMarket;
}): Promise<void> {
  const marketInfo = await input.transport.account(input.pending.market.marketPda.toBase58());
  if (marketInfo === null || marketInfo.owner !== input.context.manifest.programId) {
    fail('pending scenario market is unavailable during fund recovery');
  }
  const market = decodeMarketAccount(marketInfo.data);
  if (market.marketUuid !== input.pending.market.document.marketUuid) {
    fail('pending scenario market identity changed during fund recovery');
  }
  const positionPda = deriveUserPositionPda(
    input.context.manifest.programId,
    input.pending.market.marketPda,
    input.pending.owner.publicKey,
  ).publicKey;
  const positionInfo = await input.transport.account(positionPda.toBase58());
  if (positionInfo === null || positionInfo.owner !== input.context.manifest.programId) {
    fail('pending scenario position is unavailable during fund recovery');
  }
  const position = decodeUserPositionAccount(positionInfo.data);
  if (
    position.market !== input.pending.market.marketPda.toBase58()
    || position.owner !== input.pending.owner.publicKey.toBase58()
  ) {
    fail('pending scenario position identity changed during fund recovery');
  }
  if (position.claimed || market.state === 'closed') return;

  if (market.state === 'open' || market.state === 'frozen') {
    await waitPastDeadline(input.context, input.transport, market.resolutionDeadline);
    await timeoutAndClaim({
      context: input.context,
      transport: input.transport,
      market: input.pending.market,
      owner: input.pending.owner,
    });
    return;
  }
  if (market.state === 'settling' || (market.state === 'settled' && !position.settlementProcessed)) {
    await calculateAndClaim({
      context: input.context,
      transport: input.transport,
      market: input.pending.market,
      owner: input.pending.owner,
      direct: false,
    });
    return;
  }
  if (market.state === 'settled' || market.state === 'voided') {
    await claimOnly({
      context: input.context,
      transport: input.transport,
      market: input.pending.market,
      owner: input.pending.owner,
    });
    return;
  }
  fail(`pending scenario market cannot be recovered from state ${market.state}`);
}

async function executeScenario(
  id: DevnetScenario['id'],
  context: DevnetScenarioContext,
  session: DriverSession,
  configAuthority: () => Promise<Keypair>,
): Promise<string> {
  switch (id) {
    case 'real-sol-position': {
      const result = await runBasicPosition({
        context, session, scenario: id, asset: 'sol', owner: context.credentials.solUser,
      });
      await settleMarket({ context, transport: session.transport, market: result.market });
      await calculateAndClaim({
        context, transport: session.transport, market: result.market, owner: context.credentials.solUser, direct: false,
      });
      markRecovered(session, result.market);
      return result.placement.signature;
    }
    case 'real-usdc-position': {
      const result = await runBasicPosition({
        context, session, scenario: id, asset: 'usdc', owner: context.credentials.usdcUser,
      });
      await settleMarket({ context, transport: session.transport, market: result.market });
      await calculateAndClaim({
        context, transport: session.transport, market: result.market, owner: context.credentials.usdcUser, direct: false,
      });
      markRecovered(session, result.market);
      return result.placement.signature;
    }
    case 'settlement-and-claim': {
      const result = await runBasicPosition({
        context, session, scenario: id, asset: 'sol', owner: context.credentials.solUser,
      });
      await settleMarket({ context, transport: session.transport, market: result.market });
      const claim = await calculateAndClaim({
        context, transport: session.transport, market: result.market, owner: context.credentials.solUser, direct: false,
      });
      markRecovered(session, result.market);
      return claim.signature;
    }
    case 'direct-claim-engine-down': {
      const result = await runBasicPosition({
        context, session, scenario: id, asset: 'sol', owner: context.credentials.directClaimUser,
      });
      await settleMarket({ context, transport: session.transport, market: result.market });
      const claim = await calculateAndClaim({
        context, transport: session.transport, market: result.market, owner: context.credentials.directClaimUser, direct: true,
      });
      markRecovered(session, result.market);
      return claim.signature;
    }
    case 'paused-timeout-void': {
      const authority = await configAuthority();
      const result = await runBasicPosition({
        context, session, scenario: id, asset: 'sol', owner: context.credentials.directClaimUser,
        timeout: true,
      });
      await setPause({ context, transport: session.transport, authority: context.credentials.pauseAuthority, paused: true });
      await waitPastDeadline(context, session.transport, result.market.document.resolutionDeadline);
      const recovery = await timeoutAndClaim({
        context, transport: session.transport, market: result.market, owner: context.credentials.directClaimUser,
      });
      markRecovered(session, result.market);
      await setPause({ context, transport: session.transport, authority, paused: false });
      return recovery.signature;
    }
    case 'relayer-retry-recovery': {
      const result = await runBasicPosition({
        context, session, scenario: id, asset: 'sol', owner: context.credentials.solUser,
      });
      await replayFinalizedRaw(context, session.transport, result.placement);
      await settleMarket({ context, transport: session.transport, market: result.market });
      await calculateAndClaim({
        context, transport: session.transport, market: result.market, owner: context.credentials.solUser, direct: false,
      });
      markRecovered(session, result.market);
      return result.placement.signature;
    }
    case 'telegram-privy-receipt': {
      const result = await runBasicPosition({
        context, session, scenario: id, asset: 'sol', owner: context.credentials.solUser,
        replay: true,
      });
      await settleMarket({ context, transport: session.transport, market: result.market });
      const claim = await calculateAndClaim({
        context, transport: session.transport, market: result.market, owner: context.credentials.solUser, direct: false,
      });
      markRecovered(session, result.market);
      return claim.signature;
    }
  }
}

export async function createDevnetScenarioDriver(
  options: CreateDevnetScenarioDriverOptions = {},
): Promise<DevnetScenarioDriver> {
  const sessions = new Map<string, DriverSession>();

  function sessionFor(context: DevnetScenarioContext): DriverSession {
    assertExactDevnetManifest(context.manifest);
    const identity = [context.runId, context.rpcUrl, context.manifest.programId, context.manifest.clusterGenesisHash].join('|');
    const existing = sessions.get(context.runId);
    if (existing !== undefined) {
      if (existing.identity !== identity) fail('run ID was reused with a different devnet execution context');
      return existing;
    }
    const created: DriverSession = {
      identity,
      transport: options.transportFactory?.(context) ?? connectionTransport(context.rpcUrl),
      pendingMarkets: new Map(),
    };
    sessions.set(context.runId, created);
    return created;
  }

  async function configAuthority(context: DevnetScenarioContext): Promise<Keypair> {
    if (context.credentials.configAuthority.publicKey.toBase58() !== context.manifest.config.configAuthority) {
      fail('config-authority credential does not match the public manifest');
    }
    return context.credentials.configAuthority;
  }

  return {
    async execute(id, context) {
      const session = sessionFor(context);
      await assertExactDevnet(session.transport, context.manifest);
      const signature = await executeScenario(id, context, session, () => configAuthority(context));
      if (!await session.transport.isFinalized(signature)) fail(`scenario ${id} did not return a finalized transaction`);
      return { transactionSignature: signature };
    },
    async restoreBaseline(context) {
      const session = sessionFor(context);
      await assertExactDevnet(session.transport, context.manifest);
      if (await protocolPaused(context, session.transport)) {
        await setPause({
          context,
          transport: session.transport,
          authority: await configAuthority(context),
          paused: false,
        });
      }
      for (const [marketAddress, pending] of session.pendingMarkets) {
        await recoverPendingDevnetScenarioMarket({ context, transport: session.transport, pending });
        session.pendingMarkets.delete(marketAddress);
      }
      if (session.pendingMarkets.size !== 0) fail('pending scenario funds remained after baseline restoration');
      await assertExactDevnet(session.transport, context.manifest);
      if (await protocolPaused(context, session.transport)) fail('protocol remained paused after baseline restoration');
    },
  };
}
