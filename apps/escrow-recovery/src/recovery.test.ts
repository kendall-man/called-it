import {
  BorshWriter,
  CLASSIC_TOKEN_PROGRAM_ID,
  ESCROW_ACCOUNT_DISCRIMINATORS,
  deriveClassicAssociatedTokenAddress,
  deriveMarketPda,
  deriveProtocolConfigPda,
  deriveSolVaultPda,
  deriveUsdcVaultAddress,
  deriveUserPositionPda,
  uuidToBytes,
} from '@calledit/escrow-sdk';
import {
  Keypair,
  PublicKey,
  VersionedTransaction,
  type AccountInfo,
  type MessageV0,
  type SignatureStatus,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  DEVNET_GENESIS_HASH,
  DEVNET_WRITE_CONSENT,
  assertDevnetWriteConsent,
  prepareRecovery,
  recoveryEvidence,
  submitRecovery,
} from './recovery.js';
import type { RecoveryAccountSnapshot, RecoveryRpc } from './rpc.js';

const MARKET_UUID = '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f';

describe('standalone direct recovery', () => {
  it('builds an owner-bound SOL claim from finalized chain state', async () => {
    const fixture = recoveryFixture({ asset: 'sol', state: 'settled' });
    const preparation = await fixture.prepare('claim');
    const evidence = recoveryEvidence(preparation, null, new Date('2026-07-15T00:00:00Z'));

    expect(preparation.destination.equals(fixture.owner.publicKey)).toBe(true);
    expect(preparation.expectedAmount).toBe(3_750_000n);
    expect(preparation.transaction?.message.compiledInstructions).toHaveLength(1);
    expect(evidence.mode).toBe('dry-run');
    expect(evidence.chain.commitment).toBe('finalized');
    expect(evidence.recovery.destinationKind).toBe('owner-wallet');
    expect(evidence.transaction?.unsignedTransactionBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(evidence.transaction?.instructionKinds).toEqual(['claim_position']);
  });

  it('builds a USDC refund only to the owner canonical associated token account', async () => {
    const fixture = recoveryFixture({ asset: 'usdc', state: 'voided', destinationExists: false });
    const preparation = await fixture.prepare('refund');
    const expectedDestination = deriveClassicAssociatedTokenAddress(fixture.owner.publicKey, fixture.mint.publicKey);
    const evidence = recoveryEvidence(preparation);

    expect(preparation.destination.equals(expectedDestination)).toBe(true);
    expect(preparation.expectedAmount).toBe(5_000_000n);
    expect(preparation.requiredAtaRentLamports).toBe(2_039_280n);
    expect(evidence.market.asset).toBe('usdc');
    expect(evidence.recovery.destination).toBe(expectedDestination.toBase58());
    expect(evidence.recovery.destinationKind).toBe('canonical-associated-token-account');
  });

  it('builds one atomic timeout-void plus owner refund after the finalized deadline', async () => {
    const fixture = recoveryFixture({ asset: 'sol', state: 'open', blockTime: 2_000n, resolutionDeadline: 1_999n });
    const preparation = await fixture.prepare('timeout-refund');
    const evidence = recoveryEvidence(preparation);

    expect(preparation.eligibility).toBe('timeout-refund');
    expect(preparation.expectedAmount).toBe(3_000_000n);
    expect(preparation.transaction?.message.compiledInstructions).toHaveLength(2);
    expect(evidence.transaction?.instructionKinds).toEqual(['timeout_void', 'claim_position']);
  });

  it('inspects non-ready state without creating a transaction', async () => {
    const fixture = recoveryFixture({ asset: 'sol', state: 'open', blockTime: 1_000n, resolutionDeadline: 2_000n });
    const preparation = await fixture.prepare('inspect');
    const evidence = recoveryEvidence(preparation);

    expect(preparation.eligibility).toBe('not-ready');
    expect(preparation.transaction).toBeNull();
    expect(evidence.mode).toBe('inspect');
    expect(evidence.status).toBe('not-ready');
  });

  it('fails closed on RPC, program, config mint, market mint, and position owner mismatches', async () => {
    const cases = [
      recoveryFixture({ actualGenesis: Keypair.generate().publicKey.toBase58() }),
      recoveryFixture({ programExecutable: false }),
      recoveryFixture({ configMint: Keypair.generate().publicKey }),
      recoveryFixture({ asset: 'usdc', state: 'voided', marketMint: Keypair.generate().publicKey }),
      recoveryFixture({ positionOwner: Keypair.generate().publicKey }),
    ];
    for (const fixture of cases) {
      await expect(fixture.prepare('inspect')).rejects.toMatchObject({
        code: expect.stringMatching(/network_mismatch|program_mismatch|mint_mismatch|identity_mismatch/),
      });
    }
  });

  it('requires exact canonical-devnet consent before submission', async () => {
    const fixture = recoveryFixture();
    const preparation = await fixture.prepare('claim');
    expect(() => assertDevnetWriteConsent(preparation, undefined)).toThrow(/exact consent token/);
    expect(() => assertDevnetWriteConsent(preparation, DEVNET_WRITE_CONSENT)).not.toThrow();

    const nonDevnet = { ...preparation, expectedGenesisHash: Keypair.generate().publicKey.toBase58() };
    expect(() => assertDevnetWriteConsent(nonDevnet, DEVNET_WRITE_CONSENT)).toThrow(/canonical Solana devnet/);
  });

  it('signs locally, submits directly, and emits finalized evidence without secret material', async () => {
    const fixture = recoveryFixture();
    const preparation = await fixture.prepare('claim');
    assertDevnetWriteConsent(preparation, DEVNET_WRITE_CONSENT);
    const submission = await submitRecovery({
      preparation,
      ownerKeypair: fixture.owner,
      devnetWriteConsent: DEVNET_WRITE_CONSENT,
      rpc: fixture.rpc,
      pollAttempts: 1,
      pollDelayMs: 0,
    });
    const evidence = recoveryEvidence(preparation, submission);
    const serialized = JSON.stringify(evidence);

    expect(submission).toEqual({ status: 'finalized', signature: '1'.repeat(64), finalizedSlot: 102n });
    expect(evidence.status).toBe('finalized');
    expect(evidence.submission?.signature).toBe('1'.repeat(64));
    expect(fixture.rpc.engineRequests).toBe(0);
    expect(serialized).not.toContain(JSON.stringify([...fixture.owner.secretKey]));
    const evidenceTransaction = VersionedTransaction.deserialize(
      Buffer.from(evidence.transaction!.unsignedTransactionBase64, 'base64'),
    );
    expect(evidenceTransaction.signatures[0]?.every((byte) => byte === 0)).toBe(true);
  });
});

type Asset = 'sol' | 'usdc';
type MarketState = 'open' | 'frozen' | 'settled' | 'voided';

function recoveryFixture(options: {
  readonly asset?: Asset;
  readonly state?: MarketState;
  readonly actualGenesis?: string;
  readonly blockTime?: bigint;
  readonly resolutionDeadline?: bigint;
  readonly programExecutable?: boolean;
  readonly configMint?: PublicKey;
  readonly marketMint?: PublicKey;
  readonly positionOwner?: PublicKey;
  readonly destinationExists?: boolean;
} = {}) {
  const asset = options.asset ?? 'sol';
  const state = options.state ?? 'settled';
  const programId = Keypair.generate().publicKey;
  const owner = Keypair.generate();
  const mint = Keypair.generate();
  const configMint = options.configMint ?? mint.publicKey;
  const marketMint = options.marketMint ?? mint.publicKey;
  const marketPda = deriveMarketPda(programId, MARKET_UUID).publicKey;
  const positionPda = deriveUserPositionPda(programId, marketPda, owner.publicKey).publicKey;
  const configPda = deriveProtocolConfigPda(programId).publicKey;
  const vault = asset === 'sol'
    ? deriveSolVaultPda(programId, marketPda).publicKey
    : deriveUsdcVaultAddress(marketPda, mint.publicKey);
  const destination = deriveClassicAssociatedTokenAddress(owner.publicKey, mint.publicKey);
  const blockhash = Keypair.generate().publicKey.toBase58();
  let claimed = false;
  const accountMap = new Map<string, AccountInfo<Buffer>>();
  accountMap.set(programId.toBase58(), account(Buffer.alloc(0), Keypair.generate().publicKey, {
    executable: options.programExecutable ?? true,
  }));
  accountMap.set(configPda.toBase58(), account(configData(configMint), programId));
  accountMap.set(marketPda.toBase58(), account(marketData({
    asset,
    state,
    mint: marketMint,
    vault,
    resolutionDeadline: options.resolutionDeadline ?? 1_999n,
  }), programId));
  accountMap.set(vault.toBase58(), asset === 'sol'
    ? account(Buffer.alloc(0), programId)
    : account(tokenAccountData(mint.publicKey, marketPda), CLASSIC_TOKEN_PROGRAM_ID));
  if (asset === 'usdc') {
    accountMap.set(mint.publicKey.toBase58(), account(mintData(), CLASSIC_TOKEN_PROGRAM_ID));
    if (options.destinationExists ?? false) {
      accountMap.set(destination.toBase58(), account(tokenAccountData(mint.publicKey, owner.publicKey), CLASSIC_TOKEN_PROGRAM_ID));
    }
  }
  const positionAccount = () => account(positionData(
    options.positionOwner ?? owner.publicKey,
    marketPda,
    claimed,
    asset === 'usdc' ? 5_000_000n : 3_000_000n,
  ), programId);
  const rpc = new FixtureRpc({
    accountMap,
    positionPda,
    positionAccount,
    actualGenesis: options.actualGenesis ?? DEVNET_GENESIS_HASH,
    blockTime: options.blockTime ?? 2_000n,
    blockhash,
    onFinalize: () => { claimed = true; },
  });
  return {
    owner,
    mint,
    rpc,
    prepare: (operation: 'inspect' | 'claim' | 'refund' | 'timeout-refund') => prepareRecovery({
      operation,
      expectedGenesisHash: DEVNET_GENESIS_HASH,
      programId: programId.toBase58(),
      canonicalUsdcMint: mint.publicKey.toBase58(),
      marketUuid: MARKET_UUID,
      owner: owner.publicKey.toBase58(),
      rpc,
    }),
  };
}

class FixtureRpc implements RecoveryRpc {
  readonly engineRequests = 0;
  readonly #accountMap: Map<string, AccountInfo<Buffer>>;
  readonly #positionPda: PublicKey;
  readonly #positionAccount: () => AccountInfo<Buffer>;
  readonly #actualGenesis: string;
  readonly #blockTime: bigint;
  readonly #blockhash: string;
  readonly #onFinalize: () => void;

  constructor(input: {
    accountMap: Map<string, AccountInfo<Buffer>>;
    positionPda: PublicKey;
    positionAccount: () => AccountInfo<Buffer>;
    actualGenesis: string;
    blockTime: bigint;
    blockhash: string;
    onFinalize: () => void;
  }) {
    this.#accountMap = input.accountMap;
    this.#positionPda = input.positionPda;
    this.#positionAccount = input.positionAccount;
    this.#actualGenesis = input.actualGenesis;
    this.#blockTime = input.blockTime;
    this.#blockhash = input.blockhash;
    this.#onFinalize = input.onFinalize;
  }

  async genesisHash(): Promise<string> { return this.#actualGenesis; }
  async accounts(addresses: readonly PublicKey[]): Promise<RecoveryAccountSnapshot> {
    return {
      slot: 101n,
      accounts: addresses.map((address) => address.equals(this.#positionPda)
        ? this.#positionAccount()
        : this.#accountMap.get(address.toBase58()) ?? null),
    };
  }
  async blockTime(): Promise<bigint> { return this.#blockTime; }
  async latestBlockhash() { return { blockhash: this.#blockhash, lastValidBlockHeight: 500n }; }
  async blockHeight(): Promise<bigint> { return 100n; }
  async blockhashValid(): Promise<boolean> { return true; }
  async balance(): Promise<bigint> { return 10_000_000n; }
  async feeForMessage(_message: MessageV0): Promise<bigint> { return 5_000n; }
  async minimumTokenAccountRent(): Promise<bigint> { return 2_039_280n; }
  async sendRawTransaction(bytes: Uint8Array): Promise<string> {
    const transaction = VersionedTransaction.deserialize(bytes);
    expect(transaction.signatures[0]?.some((byte) => byte !== 0)).toBe(true);
    return '1'.repeat(64);
  }
  async signatureStatus(): Promise<SignatureStatus> {
    this.#onFinalize();
    return { slot: 102, confirmations: null, err: null, confirmationStatus: 'finalized' };
  }
}

function account(data: Uint8Array, owner: PublicKey, options: { executable?: boolean } = {}): AccountInfo<Buffer> {
  return {
    data: Buffer.from(data),
    executable: options.executable ?? false,
    lamports: 1,
    owner,
    rentEpoch: 0,
  };
}

function anchorAccount(name: keyof typeof ESCROW_ACCOUNT_DISCRIMINATORS, writer: BorshWriter): Buffer {
  return Buffer.concat([Buffer.from(ESCROW_ACCOUNT_DISCRIMINATORS[name]), Buffer.from(writer.finish())]);
}

function configData(mint: PublicKey): Buffer {
  const authority = Keypair.generate().publicKey;
  return anchorAccount('ProtocolConfig', new BorshWriter()
    .u8(1, 'version').u8(1, 'bump').bool(false, 'paused')
    .publicKey(authority).publicKey(authority).publicKey(authority).publicKey(authority)
    .publicKey(authority).publicKey(authority).publicKey(authority)
    .fixed(new PublicKey(DEVNET_GENESIS_HASH).toBytes(), 32, 'genesis')
    .publicKey(mint).publicKey(CLASSIC_TOKEN_PROGRAM_ID)
    .u64(10_000_000n, 'max sol').u64(10_000_000n, 'max usdc')
    .u64(1n, 'min sol').u64(1n, 'min usdc')
    .u64(86_400n, 'duration').u64(86_400n, 'resolution'));
}

function marketData(input: {
  asset: Asset;
  state: MarketState;
  mint: PublicKey;
  vault: PublicKey;
  resolutionDeadline: bigint;
}): Buffer {
  const stateTag = { open: 1, frozen: 2, settled: 4, voided: 5 }[input.state];
  const outcomeTag = input.state === 'settled' ? 1 : input.state === 'voided' ? 3 : 0;
  return anchorAccount('Market', new BorshWriter()
    .u8(1, 'version').u8(1, 'bump').fixed(uuidToBytes(MARKET_UUID), 16, 'uuid')
    .u64(10n, 'fixture').fixed(new Uint8Array(32), 32, 'claim hash')
    .fixed(new Uint8Array(32), 32, 'display hash').fixed(new Uint8Array(32), 32, 'odds hash')
    .fixed(new Uint8Array(32), 32, 'document hash').i64(100n, 'quote')
    .u32(500_000, 'probability').u32(1_000, 'ratio').u8(input.asset === 'sol' ? 0 : 1, 'asset')
    .publicKey(input.asset === 'sol' ? PublicKey.default : input.mint).u16(0, 'fee').u8(stateTag, 'state')
    .bool(false, 'replay').publicKey(Keypair.generate().publicKey)
    .i64(100n, 'created').i64(200n, 'in play').u64(150n, 'delay')
    .i64(1_000n, 'cutoff').i64(input.resolutionDeadline, 'deadline').u64(1n, 'oracle epoch')
    .u64(0n, 'event epoch').u64(4_000_000n, 'active back').u64(2_000_000n, 'active doubt')
    .u64(0n, 'pending back').u64(0n, 'pending doubt')
    .u64(2_000_000n, 'matched back').u64(2_000_000n, 'matched doubt')
    .u64(1_000_000n, 'forfeited').u64(input.state === 'settled' ? 1n : 0n, 'processed')
    .u8(outcomeTag, 'outcome').fixed(new Uint8Array(32), 32, 'evidence')
    .u64(1n, 'position count').u64(0n, 'claimed count').publicKey(input.vault).u8(1, 'vault bump'));
}

function positionData(owner: PublicKey, market: PublicKey, claimed: boolean, amount: bigint): Buffer {
  return anchorAccount('UserPosition', new BorshWriter()
    .u8(1, 'version').u8(1, 'bump').publicKey(market).publicKey(owner).u8(0, 'side')
    .u64(amount, 'active').u64(0n, 'pending').u64(0n, 'refundable')
    .u64(amount, 'base entitlement').bool(true, 'processed').u64(1n, 'nonce')
    .bool(claimed, 'claimed').u64(amount, 'paid').u64(1n, 'created slot').u64(2n, 'updated slot'));
}

function mintData(): Buffer {
  const data = Buffer.alloc(82);
  data[44] = 6;
  data[45] = 1;
  return data;
}

function tokenAccountData(mint: PublicKey, owner: PublicKey): Buffer {
  const data = Buffer.alloc(165);
  data.set(mint.toBytes(), 0);
  data.set(owner.toBytes(), 32);
  data[108] = 1;
  return data;
}
