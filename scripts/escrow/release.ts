import { createHash } from 'node:crypto';

import type {
  BuildManifest,
  CheckResult,
  EvidenceRpcReader,
  OracleSetAccount,
  ProtocolConfigAccount,
  ReleaseManifest,
  RpcAccount,
  RpcReader,
} from './types.js';
import { EscrowControlError, EXIT } from './types.js';
import {
  bigintLe,
  decodeBase58,
  encodeBase58,
  equalJson,
  failMismatch,
  sha256,
} from './util.js';

export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const CLASSIC_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const NETWORK_GENESIS: Readonly<Partial<Record<ReleaseManifest['network'], string>>> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
const CANONICAL_USDC: Readonly<Partial<Record<ReleaseManifest['network'], string>>> = {
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};
const BASE58_VALUE = /^[1-9A-HJ-NP-Za-km-z]*$/;

interface NormalizedInstruction {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly data: string;
}

interface NormalizedTokenBalance {
  readonly account: string;
  readonly mint: string;
  readonly amount: string;
}

interface NormalizedFinalizedTransaction {
  readonly slot: number;
  readonly blockTime: number;
  readonly accountKeys: readonly string[];
  readonly instructions: readonly NormalizedInstruction[];
  readonly preBalances: readonly number[];
  readonly postBalances: readonly number[];
  readonly preTokenBalances: readonly NormalizedTokenBalance[];
  readonly postTokenBalances: readonly NormalizedTokenBalance[];
}

interface TransactionResolutionContext {
  readonly signature: string;
  readonly accountKeys: readonly string[];
}

function malformedTransaction(signature: string, detail: string): never {
  throw new EscrowControlError(EXIT.mismatch, `evidence transaction is malformed (${detail}): ${signature}`);
}

function transactionRecord(value: unknown, signature: string, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) malformedTransaction(signature, label);
  return value as Record<string, unknown>;
}

function transactionArray(value: unknown, signature: string, label: string): readonly unknown[] {
  if (!Array.isArray(value)) malformedTransaction(signature, label);
  return value;
}

function transactionInteger(value: unknown, signature: string, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) malformedTransaction(signature, label);
  return value;
}

function transactionPublicKey(value: unknown, signature: string, label: string): string {
  if (typeof value !== 'string' || !BASE58_VALUE.test(value) || decodeBase58(value).length !== 32) {
    malformedTransaction(signature, label);
  }
  return value;
}

function transactionPublicKeys(value: unknown, signature: string, label: string): readonly string[] {
  return transactionArray(value, signature, label)
    .map((entry, index) => transactionPublicKey(entry, signature, `${label}[${index}]`));
}

function resolvedAccount(value: unknown, context: TransactionResolutionContext, label: string): string {
  const index = transactionInteger(value, context.signature, label);
  const account = context.accountKeys[index];
  if (account === undefined) malformedTransaction(context.signature, `${label} is outside resolved account keys`);
  return account;
}

function loadedAccountKeys(value: unknown, signature: string): readonly string[] {
  if (value === undefined || value === null) return [];
  const loaded = transactionRecord(value, signature, 'meta.loadedAddresses');
  return [
    ...transactionPublicKeys(loaded.writable, signature, 'meta.loadedAddresses.writable'),
    ...transactionPublicKeys(loaded.readonly, signature, 'meta.loadedAddresses.readonly'),
  ];
}

function transactionBalances(
  value: unknown,
  context: TransactionResolutionContext,
  label: string,
): readonly number[] {
  const balances = transactionArray(value, context.signature, label);
  if (balances.length !== context.accountKeys.length) {
    malformedTransaction(context.signature, `${label} does not align with resolved account keys`);
  }
  return balances.map((entry, index) => transactionInteger(entry, context.signature, `${label}[${index}]`));
}

function transactionInstructions(
  value: unknown,
  context: TransactionResolutionContext,
): readonly NormalizedInstruction[] {
  return transactionArray(value, context.signature, 'transaction.message.instructions').map((entry, instructionIndex) => {
    const label = `transaction.message.instructions[${instructionIndex}]`;
    const instruction = transactionRecord(entry, context.signature, label);
    const data = instruction.data;
    if (typeof data !== 'string' || !BASE58_VALUE.test(data)) malformedTransaction(context.signature, `${label}.data`);
    return {
      programId: resolvedAccount(instruction.programIdIndex, context, `${label}.programIdIndex`),
      accounts: transactionArray(instruction.accounts, context.signature, `${label}.accounts`)
        .map((accountIndex, index) => resolvedAccount(accountIndex, context, `${label}.accounts[${index}]`)),
      data,
    };
  });
}

function transactionTokenBalances(
  value: unknown,
  context: TransactionResolutionContext,
  label: string,
): readonly NormalizedTokenBalance[] {
  if (value === undefined || value === null) return [];
  const seenAccounts = new Set<string>();
  return transactionArray(value, context.signature, label).map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const balance = transactionRecord(entry, context.signature, itemLabel);
    const account = resolvedAccount(balance.accountIndex, context, `${itemLabel}.accountIndex`);
    if (seenAccounts.has(account)) malformedTransaction(context.signature, `${label} contains duplicate accounts`);
    seenAccounts.add(account);
    const tokenAmount = transactionRecord(balance.uiTokenAmount, context.signature, `${itemLabel}.uiTokenAmount`);
    const amount = tokenAmount.amount;
    if (typeof amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(amount)) {
      malformedTransaction(context.signature, `${itemLabel}.uiTokenAmount.amount`);
    }
    return {
      account,
      mint: transactionPublicKey(balance.mint, context.signature, `${itemLabel}.mint`),
      amount,
    };
  });
}

class Cursor {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  bytes(length: number): Buffer {
    if (length < 0 || this.offset + length > this.data.length) failMismatch('account data is truncated');
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  u8(): number {
    return this.bytes(1)[0]!;
  }

  bool(): boolean {
    const value = this.u8();
    if (value !== 0 && value !== 1) failMismatch('invalid Borsh boolean');
    return value === 1;
  }

  u32(): number {
    return this.bytes(4).readUInt32LE();
  }

  u64(): string {
    return this.bytes(8).readBigUInt64LE().toString();
  }

  publicKey(): string {
    return encodeBase58(this.bytes(32));
  }

  done(): void {
    if (this.offset !== this.data.length) failMismatch(`account data has ${this.data.length - this.offset} trailing bytes`);
  }

  doneWithZeroPadding(): void {
    const trailing = this.data.subarray(this.offset);
    if (trailing.some((byte) => byte !== 0)) failMismatch('account data has non-zero trailing bytes');
    this.offset = this.data.length;
  }
}

function accountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

function checkedAccountBody(account: RpcAccount, name: string): Cursor {
  const expected = accountDiscriminator(name);
  if (account.data.length < 8 || !account.data.subarray(0, 8).equals(expected)) {
    failMismatch(`${name} account discriminator mismatch`);
  }
  return new Cursor(account.data.subarray(8));
}

export function decodeProtocolConfig(account: RpcAccount): ProtocolConfigAccount {
  const cursor = checkedAccountBody(account, 'ProtocolConfig');
  const value: ProtocolConfigAccount = {
    version: cursor.u8(),
    bump: cursor.u8(),
    paused: cursor.bool(),
    configAuthority: cursor.publicKey(),
    pauseAuthority: cursor.publicKey(),
    marketCreationAuthority: cursor.publicKey(),
    feedOperatorAuthority: cursor.publicKey(),
    oracleSet: cursor.publicKey(),
    relayerFeePayer: cursor.publicKey(),
    residualRecipient: cursor.publicKey(),
    clusterGenesisHash: encodeBase58(cursor.bytes(32)),
    canonicalUsdcMint: cursor.publicKey(),
    allowedTokenProgram: cursor.publicKey(),
    maxSolPosition: cursor.u64(),
    maxUsdcPosition: cursor.u64(),
    minSolPosition: cursor.u64(),
    minUsdcPosition: cursor.u64(),
    maxMarketDurationSeconds: cursor.u64(),
    maxResolutionDelaySeconds: cursor.u64(),
  };
  cursor.doneWithZeroPadding();
  return value;
}

export function decodeOracleSet(account: RpcAccount): OracleSetAccount {
  const cursor = checkedAccountBody(account, 'OracleSet');
  const version = cursor.u8();
  const bump = cursor.u8();
  const epoch = cursor.u64();
  const signerCount = cursor.u32();
  if (signerCount > 16) failMismatch('oracle signer vector exceeds the verifier bound');
  const signers = Array.from({ length: signerCount }, () => cursor.publicKey());
  const threshold = cursor.u8();
  const activationSlot = cursor.u64();
  const option = cursor.u8();
  if (option !== 0 && option !== 1) failMismatch('oracle retirement slot option is invalid');
  const retirementSlot = option === 1 ? cursor.u64() : null;
  cursor.doneWithZeroPadding();
  return { version, bump, epoch, signers, threshold, activationSlot, retirementSlot };
}

export function decodeProgramDataAddress(account: RpcAccount): string {
  if (account.data.length !== 36 || account.data.readUInt32LE(0) !== 2) {
    failMismatch('program account is not an upgradeable-loader Program account');
  }
  return encodeBase58(account.data.subarray(4, 36));
}

export function decodeUpgradeAuthority(account: RpcAccount): string | null {
  if (account.data.length < 13 || account.data.readUInt32LE(0) !== 3) {
    failMismatch('program-data account is malformed');
  }
  const option = account.data[12];
  if (option === 0) return null;
  if (option !== 1 || account.data.length < 45) failMismatch('program-data upgrade authority option is malformed');
  return encodeBase58(account.data.subarray(13, 45));
}

export function decodeClassicMint(account: RpcAccount): { readonly decimals: number; readonly initialized: boolean } {
  if (account.data.length !== 82) failMismatch('canonical USDC is not a classic SPL Mint account');
  return { decimals: account.data[44]!, initialized: account.data[45] === 1 };
}

function assertEqual(actual: unknown, expected: unknown, label: string, checks: string[]): void {
  if (!equalJson(actual, expected)) failMismatch(`${label} mismatch`);
  checks.push(label);
}

function assertAccountOwner(account: RpcAccount, expected: string, label: string, checks: string[]): void {
  assertEqual(account.owner, expected, `${label} owner`, checks);
}

function assertSeparateAuthorities(manifest: ReleaseManifest, checks: string[]): void {
  const roles = {
    upgrade: manifest.upgradeAuthority,
    config: manifest.config.configAuthority,
    pause: manifest.config.pauseAuthority,
    marketCreation: manifest.config.marketCreationAuthority,
    feedOperator: manifest.config.feedOperatorAuthority,
    relayer: manifest.config.relayerFeePayer,
  };
  if (new Set(Object.values(roles)).size !== Object.keys(roles).length) {
    failMismatch('upgrade, config, pause, market-creation, feed-operator, and relayer authorities must be separate');
  }
  if (manifest.oracleSet.signers.some((signer) => Object.values(roles).includes(signer))) {
    failMismatch('oracle signers must be separate from operational authorities');
  }
  checks.push('separate operational authorities', 'oracle signer independence');
}

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function powMod(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let factor = mod(base, modulus);
  let power = exponent;
  while (power > 0n) {
    if ((power & 1n) === 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    power >>= 1n;
  }
  return result;
}

function inverse(value: bigint, modulus: bigint): bigint {
  return powMod(value, modulus - 2n, modulus);
}

function isEd25519Point(bytes: Buffer): boolean {
  if (bytes.length !== 32) return false;
  const encoded = Buffer.from(bytes);
  encoded[31] = encoded[31]! & 0x7f;
  let y = 0n;
  for (let index = 31; index >= 0; index -= 1) y = (y << 8n) | BigInt(encoded[index]!);
  const p = (1n << 255n) - 19n;
  if (y >= p) return false;
  const d = mod(-121665n * inverse(121666n, p), p);
  const y2 = mod(y * y, p);
  const x2 = mod((y2 - 1n) * inverse(d * y2 + 1n, p), p);
  let x = powMod(x2, (p + 3n) / 8n, p);
  if (mod(x * x - x2, p) !== 0n) {
    const sqrtMinusOne = powMod(2n, (p - 1n) / 4n, p);
    x = mod(x * sqrtMinusOne, p);
  }
  return mod(x * x - x2, p) === 0n;
}

function createProgramAddress(seeds: readonly Buffer[], programId: string): string {
  if (seeds.length > 16 || seeds.some((seed) => seed.length > 32)) failMismatch('invalid PDA seed shape');
  const digest = createHash('sha256')
    .update(Buffer.concat([...seeds, decodeBase58(programId), Buffer.from('ProgramDerivedAddress')]))
    .digest();
  if (isEd25519Point(digest)) failMismatch('PDA candidate lies on the Ed25519 curve');
  return encodeBase58(digest);
}

export function findProgramAddress(seeds: readonly Buffer[], programId: string): { readonly address: string; readonly bump: number } {
  for (let bump = 255; bump >= 0; bump -= 1) {
    try {
      return { address: createProgramAddress([...seeds, Buffer.from([bump])], programId), bump };
    } catch (error) {
      if (!(error instanceof EscrowControlError) || !error.message.includes('Ed25519')) throw error;
    }
  }
  failMismatch('unable to derive PDA');
}

function expectedConfig(manifest: ReleaseManifest): ProtocolConfigAccount {
  const configPda = findProgramAddress([Buffer.from('config')], manifest.programId);
  if (configPda.address !== manifest.configPda) failMismatch('config PDA derivation mismatch');
  return {
    version: manifest.config.custodyVersion,
    bump: configPda.bump,
    paused: manifest.config.paused,
    configAuthority: manifest.config.configAuthority,
    pauseAuthority: manifest.config.pauseAuthority,
    marketCreationAuthority: manifest.config.marketCreationAuthority,
    feedOperatorAuthority: manifest.config.feedOperatorAuthority,
    oracleSet: manifest.config.oracleSet,
    relayerFeePayer: manifest.config.relayerFeePayer,
    residualRecipient: manifest.config.residualRecipient,
    clusterGenesisHash: manifest.clusterGenesisHash,
    canonicalUsdcMint: manifest.config.canonicalUsdcMint,
    allowedTokenProgram: manifest.config.allowedTokenProgram,
    maxSolPosition: manifest.config.maxSolPosition,
    maxUsdcPosition: manifest.config.maxUsdcPosition,
    minSolPosition: manifest.config.minSolPosition,
    minUsdcPosition: manifest.config.minUsdcPosition,
    maxMarketDurationSeconds: manifest.config.maxMarketDurationSeconds,
    maxResolutionDelaySeconds: manifest.config.maxResolutionDelaySeconds,
  };
}

function expectedOracle(manifest: ReleaseManifest): OracleSetAccount {
  const oraclePda = findProgramAddress(
    [Buffer.from('oracle-set'), bigintLe(BigInt(manifest.oracleSet.epoch))],
    manifest.programId,
  );
  if (oraclePda.address !== manifest.oracleSet.address) failMismatch('oracle-set PDA derivation mismatch');
  return {
    version: manifest.oracleSet.custodyVersion,
    bump: oraclePda.bump,
    epoch: manifest.oracleSet.epoch,
    signers: manifest.oracleSet.signers,
    threshold: 2,
    activationSlot: manifest.oracleSet.activationSlot,
    retirementSlot: manifest.oracleSet.retirementSlot,
  };
}

export async function verifyRelease(
  manifest: ReleaseManifest,
  localBuild: BuildManifest,
  rpc: RpcReader,
  localSbf: Uint8Array,
): Promise<CheckResult> {
  const checks: string[] = [];
  assertEqual(localBuild, manifest.build, 'local build provenance', checks);
  assertEqual(manifest.programId, manifest.build.programId, 'program/build identity', checks);
  assertEqual(manifest.upgradeableLoaderProgramId, UPGRADEABLE_LOADER, 'upgradeable loader identity', checks);
  assertEqual(manifest.config.allowedTokenProgram, CLASSIC_TOKEN_PROGRAM, 'classic token program identity', checks);
  const expectedGenesis = NETWORK_GENESIS[manifest.network];
  if (expectedGenesis !== undefined) assertEqual(manifest.clusterGenesisHash, expectedGenesis, 'network/genesis binding', checks);
  const expectedUsdc = CANONICAL_USDC[manifest.network];
  if (expectedUsdc !== undefined) assertEqual(manifest.config.canonicalUsdcMint, expectedUsdc, 'canonical USDC identity', checks);
  assertSeparateAuthorities(manifest, checks);

  const genesis = await rpc.genesisHash();
  assertEqual(genesis, manifest.clusterGenesisHash, 'RPC cluster genesis', checks);

  const program = await rpc.account(manifest.programId);
  assertAccountOwner(program, manifest.upgradeableLoaderProgramId, 'program account', checks);
  assertEqual(program.executable, true, 'program executable flag', checks);
  assertEqual(decodeProgramDataAddress(program), manifest.programDataAddress, 'program-data address', checks);

  const programData = await rpc.account(manifest.programDataAddress);
  assertAccountOwner(programData, manifest.upgradeableLoaderProgramId, 'program-data account', checks);
  assertEqual(programData.executable, false, 'program-data executable flag', checks);
  assertEqual(decodeUpgradeAuthority(programData), manifest.upgradeAuthority, 'upgrade authority', checks);
  const deployedProgram = programData.data.subarray(45);
  if (deployedProgram.length < localSbf.length || !deployedProgram.subarray(0, localSbf.length).equals(Buffer.from(localSbf))) {
    failMismatch('deployed SBF bytes do not match the release artifact');
  }
  if (deployedProgram.subarray(localSbf.length).some((byte) => byte !== 0)) {
    failMismatch('deployed ProgramData contains unexpected non-zero bytes after the release artifact');
  }
  checks.push('deployed SBF bytes');

  const configAccount = await rpc.account(manifest.configPda);
  assertAccountOwner(configAccount, manifest.programId, 'config account', checks);
  assertEqual(configAccount.executable, false, 'config executable flag', checks);
  assertEqual(decodeProtocolConfig(configAccount), expectedConfig(manifest), 'decoded protocol config', checks);

  const oracleAccount = await rpc.account(manifest.oracleSet.address);
  assertAccountOwner(oracleAccount, manifest.programId, 'oracle-set account', checks);
  assertEqual(oracleAccount.executable, false, 'oracle-set executable flag', checks);
  assertEqual(decodeOracleSet(oracleAccount), expectedOracle(manifest), 'decoded 2-of-3 oracle set', checks);

  const mint = await rpc.account(manifest.config.canonicalUsdcMint);
  assertAccountOwner(mint, CLASSIC_TOKEN_PROGRAM, 'canonical USDC mint', checks);
  assertEqual(mint.executable, false, 'canonical USDC executable flag', checks);
  assertEqual(decodeClassicMint(mint), { decimals: 6, initialized: true }, 'canonical USDC mint layout', checks);
  return { ok: true, checks };
}

export async function captureReleaseManifest(
  network: ReleaseManifest['network'],
  build: BuildManifest,
  rpc: RpcReader,
): Promise<ReleaseManifest> {
  const clusterGenesisHash = await rpc.genesisHash();
  const program = await rpc.account(build.programId);
  const programDataAddress = decodeProgramDataAddress(program);
  const programData = await rpc.account(programDataAddress);
  const upgradeAuthority = decodeUpgradeAuthority(programData);
  if (upgradeAuthority === null) failMismatch('release program has no upgrade authority');
  const configPda = findProgramAddress([Buffer.from('config')], build.programId).address;
  const config = decodeProtocolConfig(await rpc.account(configPda));
  const oracleSet = decodeOracleSet(await rpc.account(config.oracleSet));
  if (oracleSet.signers.length !== 3) failMismatch('release oracle set must contain exactly three signers');
  return {
    schemaVersion: 1,
    network,
    clusterGenesisHash,
    programId: build.programId,
    upgradeableLoaderProgramId: UPGRADEABLE_LOADER,
    programDataAddress,
    upgradeAuthority,
    configPda,
    build,
    config: {
      custodyVersion: config.version,
      paused: config.paused,
      configAuthority: config.configAuthority,
      pauseAuthority: config.pauseAuthority,
      marketCreationAuthority: config.marketCreationAuthority,
      feedOperatorAuthority: config.feedOperatorAuthority,
      oracleSet: config.oracleSet,
      relayerFeePayer: config.relayerFeePayer,
      residualRecipient: config.residualRecipient,
      canonicalUsdcMint: config.canonicalUsdcMint,
      allowedTokenProgram: config.allowedTokenProgram,
      minSolPosition: config.minSolPosition,
      maxSolPosition: config.maxSolPosition,
      minUsdcPosition: config.minUsdcPosition,
      maxUsdcPosition: config.maxUsdcPosition,
      maxMarketDurationSeconds: config.maxMarketDurationSeconds,
      maxResolutionDelaySeconds: config.maxResolutionDelaySeconds,
    },
    oracleSet: {
      address: config.oracleSet,
      custodyVersion: oracleSet.version,
      epoch: oracleSet.epoch,
      signers: [oracleSet.signers[0]!, oracleSet.signers[1]!, oracleSet.signers[2]!],
      threshold: 2,
      activationSlot: oracleSet.activationSlot,
      retirementSlot: oracleSet.retirementSlot,
    },
  };
}

export class JsonRpcReader implements EvidenceRpcReader {
  private requestId = 0;

  constructor(private readonly rpcUrl: string) {
    let url: URL;
    try {
      url = new URL(rpcUrl);
    } catch {
      throw new EscrowControlError(EXIT.input, 'RPC URL is invalid');
    }
    if (!['https:', 'http:'].includes(url.protocol)) throw new EscrowControlError(EXIT.input, 'RPC URL must use HTTP(S)');
  }

  async genesisHash(): Promise<string> {
    return this.call<string>('getGenesisHash', []);
  }

  async account(address: string): Promise<RpcAccount> {
    const result = await this.call<{
      readonly value: null | {
        readonly owner: string;
        readonly executable: boolean;
        readonly lamports: number;
        readonly data: readonly [string, string];
      };
    }>('getAccountInfo', [address, { commitment: 'finalized', encoding: 'base64' }]);
    if (result.value === null) throw new EscrowControlError(EXIT.mismatch, `required account is missing: ${address}`);
    if (result.value.data[1] !== 'base64') throw new EscrowControlError(EXIT.mismatch, 'RPC returned an unexpected account encoding');
    return {
      owner: result.value.owner,
      executable: result.value.executable,
      lamports: result.value.lamports,
      data: Buffer.from(result.value.data[0], 'base64'),
    };
  }

  async finalizedTransaction(signature: string): Promise<NormalizedFinalizedTransaction> {
    const result = await this.call<unknown>('getTransaction', [signature, {
      commitment: 'finalized',
      encoding: 'json',
      maxSupportedTransactionVersion: 0,
    }]);
    if (result === null) throw new EscrowControlError(EXIT.mismatch, `required finalized transaction is missing: ${signature}`);
    const transactionResult = transactionRecord(result, signature, 'result');
    const meta = transactionRecord(transactionResult.meta, signature, 'meta');
    if (meta.err !== null) throw new EscrowControlError(EXIT.mismatch, `evidence transaction failed: ${signature}`);
    const transaction = transactionRecord(transactionResult.transaction, signature, 'transaction');
    const message = transactionRecord(transaction.message, signature, 'transaction.message');
    const accountKeys = [
      ...transactionPublicKeys(message.accountKeys, signature, 'transaction.message.accountKeys'),
      ...loadedAccountKeys(meta.loadedAddresses, signature),
    ];
    if (new Set(accountKeys).size !== accountKeys.length) malformedTransaction(signature, 'resolved account keys contain duplicates');
    const resolution = { signature, accountKeys } satisfies TransactionResolutionContext;
    return {
      slot: transactionInteger(transactionResult.slot, signature, 'slot'),
      blockTime: transactionInteger(transactionResult.blockTime, signature, 'blockTime'),
      accountKeys,
      instructions: transactionInstructions(message.instructions, resolution),
      preBalances: transactionBalances(meta.preBalances, resolution, 'meta.preBalances'),
      postBalances: transactionBalances(meta.postBalances, resolution, 'meta.postBalances'),
      preTokenBalances: transactionTokenBalances(meta.preTokenBalances, resolution, 'meta.preTokenBalances'),
      postTokenBalances: transactionTokenBalances(meta.postTokenBalances, resolution, 'meta.postTokenBalances'),
    };
  }

  private async call<T>(method: string, params: readonly unknown[]): Promise<T> {
    this.requestId += 1;
    let response: Response;
    try {
      response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.requestId, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new EscrowControlError(EXIT.rpc, `RPC request failed for ${method}`);
    }
    if (!response.ok) throw new EscrowControlError(EXIT.rpc, `RPC request returned HTTP ${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EscrowControlError(EXIT.rpc, 'RPC returned invalid JSON');
    }
    if (payload === null || typeof payload !== 'object') throw new EscrowControlError(EXIT.rpc, 'RPC response is malformed');
    const record = payload as Record<string, unknown>;
    if (record.error !== undefined) throw new EscrowControlError(EXIT.rpc, `RPC rejected ${method}`);
    if (!('result' in record)) throw new EscrowControlError(EXIT.rpc, 'RPC response has no result');
    return record.result as T;
  }
}

export function manifestDigest(manifest: ReleaseManifest): string {
  return sha256(JSON.stringify(manifest));
}
