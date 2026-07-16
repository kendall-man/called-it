import {
  BorshWriter,
  ESCROW_ACCOUNT_DISCRIMINATORS,
  buildUnsignedV0Transaction,
  deriveClassicAssociatedTokenAddress,
  deriveMarketPda,
  deriveSolVaultPda,
  deriveUserPositionPda,
  deriveUsdcVaultAddress,
  materializeInstruction,
  uuidToBytes,
  type MarketAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountInfo,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  DirectClaimError,
  assertDirectClaimBindings,
  prepareDirectClaim,
  submitDirectClaim,
  verifyDirectClaimTransactionBeforeSigning,
  type DirectClaimRpc,
} from './direct-claim';

const MARKET_ID = '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

describe('direct owner claim', () => {
  it.each(['sol', 'usdc'] as const)(
    'builds and finalizes a %s claim without any engine dependency',
    async (asset) => {
      const fixture = claimFixture(asset);
      const rpc = fixtureRpc(fixture);
      const preparation = await prepareDirectClaim({
        canonicalUsdcMint: fixture.mint.toBase58(),
        expectedGenesisHash: GENESIS,
        marketId: MARKET_ID,
        network: 'devnet',
        owner: fixture.owner.publicKey.toBase58(),
        programId: fixture.programId.toBase58(),
        rpcUrl: 'https://rpc.invalid.example',
        rpc,
      });
      const expectedDestination = asset === 'sol'
        ? fixture.owner.publicKey
        : deriveClassicAssociatedTokenAddress(fixture.owner.publicKey, fixture.mint);
      expect(preparation.destination).toBe(expectedDestination.toBase58());
      expect(preparation.transaction.message.compiledInstructions).toHaveLength(1);
      expect(preparation.transaction.message.compiledInstructions[0]?.data).toHaveLength(8);
      preparation.transaction.sign([fixture.owner]);
      const result = await submitDirectClaim({
        preparation,
        rpcUrl: 'https://rpc.invalid.example',
        signedBytes: preparation.transaction.serialize(),
        rpc,
        pollAttempts: 1,
        pollDelayMs: 0,
      });
      expect(result).toEqual({ kind: 'finalized', signature: '1'.repeat(64) });
      expect(rpc.engineRequests).toBe(0);
    },
  );

  it('accepts completed-match replay claims and preserves the replay label', async () => {
    const fixture = claimFixture('sol', { replay: true });
    const preparation = await prepareDirectClaim({
      canonicalUsdcMint: fixture.mint.toBase58(),
      expectedGenesisHash: GENESIS,
      marketId: MARKET_ID,
      network: 'devnet',
      owner: fixture.owner.publicKey.toBase58(),
      programId: fixture.programId.toBase58(),
      rpcUrl: 'https://rpc.invalid.example',
      rpc: fixtureRpc(fixture),
    });
    expect(preparation.replay).toBe(true);
  });

  it('detects an already-claimed position before submitting a duplicate', async () => {
    const fixture = claimFixture('sol', { claimed: true });
    await expect(prepareDirectClaim({
      canonicalUsdcMint: fixture.mint.toBase58(),
      expectedGenesisHash: GENESIS,
      marketId: MARKET_ID,
      network: 'devnet',
      owner: fixture.owner.publicKey.toBase58(),
      programId: fixture.programId.toBase58(),
      rpcUrl: 'https://rpc.invalid.example',
      rpc: fixtureRpc(fixture),
    })).rejects.toMatchObject({ code: 'already_claimed' });
  });

  it('blocks Privy approval when SOL cannot cover the claim fee or USDC ATA rent', async () => {
    const fixture = claimFixture('usdc');
    const rpc = fixtureRpc(fixture);
    rpc.getBalance = async () => 2_000_000;
    await expect(prepareDirectClaim({
      canonicalUsdcMint: fixture.mint.toBase58(),
      expectedGenesisHash: GENESIS,
      marketId: MARKET_ID,
      network: 'devnet',
      owner: fixture.owner.publicKey.toBase58(),
      programId: fixture.programId.toBase58(),
      rpcUrl: 'https://rpc.invalid.example',
      rpc,
    })).rejects.toMatchObject({ code: 'insufficient_fee_balance' });
  });

  it('rejects destination, owner, program, blockhash, and extra-instruction substitution', () => {
    const fixture = claimFixture('usdc');
    const expected = {
      asset: 'usdc' as const,
      canonicalUsdcMint: fixture.mint,
      marketId: MARKET_ID,
      owner: fixture.owner.publicKey,
      programId: fixture.programId,
      recentBlockhash: fixture.blockhash,
    };
    const exactInstruction = materializeInstruction({
      kind: 'claim_position',
      marketUuid: MARKET_ID,
      owner: fixture.owner.publicKey,
      asset: 'usdc',
      canonicalUsdcMint: fixture.mint,
    }, { programId: fixture.programId });
    const cases = [
      buildUnsignedV0Transaction({
        feePayer: fixture.owner.publicKey,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [exactInstruction],
      }),
      buildUnsignedV0Transaction({
        feePayer: fixture.owner.publicKey,
        recentBlockhash: fixture.blockhash,
        instructions: [materializeInstruction({
          kind: 'claim_position',
          marketUuid: MARKET_ID,
          owner: Keypair.generate().publicKey,
          asset: 'usdc',
          canonicalUsdcMint: fixture.mint,
        }, { programId: fixture.programId })],
      }),
      buildUnsignedV0Transaction({
        feePayer: fixture.owner.publicKey,
        recentBlockhash: fixture.blockhash,
        instructions: [materializeInstruction({
          kind: 'claim_position',
          marketUuid: MARKET_ID,
          owner: fixture.owner.publicKey,
          asset: 'usdc',
          canonicalUsdcMint: Keypair.generate().publicKey,
        }, { programId: fixture.programId })],
      }),
      buildUnsignedV0Transaction({
        feePayer: fixture.owner.publicKey,
        recentBlockhash: fixture.blockhash,
        instructions: [materializeInstruction({
          kind: 'claim_position',
          marketUuid: MARKET_ID,
          owner: fixture.owner.publicKey,
          asset: 'usdc',
          canonicalUsdcMint: fixture.mint,
        }, { programId: Keypair.generate().publicKey })],
      }),
      buildUnsignedV0Transaction({
        feePayer: fixture.owner.publicKey,
        recentBlockhash: fixture.blockhash,
        instructions: [
          exactInstruction,
          SystemProgram.transfer({
            fromPubkey: fixture.owner.publicKey,
            toPubkey: Keypair.generate().publicKey,
            lamports: 1,
          }),
        ],
      }),
    ];
    for (const transaction of cases) {
      expect(() => verifyDirectClaimTransactionBeforeSigning(transaction, expected))
        .toThrow(DirectClaimError);
    }
  });

  it('rejects a substituted market vault and non-final claim state', () => {
    const fixture = claimFixture('sol');
    expect(() => assertDirectClaimBindings({
      canonicalUsdcMint: fixture.mint,
      market: { ...fixture.market, vault: Keypair.generate().publicKey.toBase58() },
      marketId: MARKET_ID,
      marketPda: fixture.marketPda,
      owner: fixture.owner.publicKey,
      position: fixture.position,
      positionPda: fixture.positionPda,
      programId: fixture.programId,
    })).toThrow(DirectClaimError);
    expect(() => assertDirectClaimBindings({
      canonicalUsdcMint: fixture.mint,
      market: { ...fixture.market, state: 'open' },
      marketId: MARKET_ID,
      marketPda: fixture.marketPda,
      owner: fixture.owner.publicKey,
      position: fixture.position,
      positionPda: fixture.positionPda,
      programId: fixture.programId,
    })).toThrow(DirectClaimError);
  });

  it('rejects a USDC vault whose token owner binding is substituted', async () => {
    const fixture = claimFixture('usdc');
    const validRpc = fixtureRpc(fixture);
    const rpc: DirectClaimRpc = {
      ...validRpc,
      async getAccountInfo(address) {
        if (address.toBase58() === fixture.market.vault) {
          return tokenAccountInfo(fixture.mint, Keypair.generate().publicKey);
        }
        return validRpc.getAccountInfo(address);
      },
    };
    await expect(prepareDirectClaim({
      canonicalUsdcMint: fixture.mint.toBase58(),
      expectedGenesisHash: GENESIS,
      marketId: MARKET_ID,
      network: 'devnet',
      owner: fixture.owner.publicKey.toBase58(),
      programId: fixture.programId.toBase58(),
      rpcUrl: 'https://rpc.invalid.example',
      rpc,
    })).rejects.toMatchObject({ code: 'transaction_changed' });
  });
});

function claimFixture(
  asset: 'sol' | 'usdc',
  overrides: { readonly claimed?: boolean; readonly replay?: boolean } = {},
) {
  const programId = Keypair.generate().publicKey;
  const owner = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const marketPda = deriveMarketPda(programId, MARKET_ID).publicKey;
  const positionPda = deriveUserPositionPda(programId, marketPda, owner.publicKey).publicKey;
  const vault = asset === 'sol'
    ? deriveSolVaultPda(programId, marketPda).publicKey
    : deriveUsdcVaultAddress(marketPda, mint);
  const market: MarketAccount = {
    version: 1,
    bump: 1,
    marketUuid: MARKET_ID,
    fixtureId: 42n,
    claimSpecificationHash: bytes(1),
    displayTermsHash: bytes(2),
    oddsMessageHash: bytes(3),
    marketDocumentHash: bytes(4),
    quoteTimestamp: 1n,
    probabilityPpm: 500_000,
    ratioMilli: 1_000,
    asset,
    tokenMint: asset === 'usdc' ? mint.toBase58() : null,
    feeBps: 0,
    state: 'settled',
    replay: overrides.replay ?? false,
    residualRecipient: Keypair.generate().publicKey.toBase58(),
    createdTimestamp: 1n,
    inPlayStartTimestamp: 2n,
    activationDelaySeconds: 150n,
    positionCutoffTimestamp: 3n,
    resolutionDeadline: 4n,
    oracleSetEpoch: 1n,
    eventEpoch: 1n,
    activeBackTotal: 10n,
    activeDoubtTotal: 10n,
    pendingBackTotal: 0n,
    pendingDoubtTotal: 0n,
    finalMatchedBackTotal: 10n,
    finalMatchedDoubtTotal: 10n,
    finalForfeitedTotal: 10n,
    settlementProcessedPositionCount: 1n,
    settlementOutcome: 'claim_won',
    settlementEvidenceHash: bytes(5),
    positionCount: 1n,
    claimedPositionCount: overrides.claimed ? 1n : 0n,
    vault: vault.toBase58(),
    vaultBump: 1,
  };
  const position: UserPositionAccount = {
    version: 1,
    bump: 1,
    market: marketPda.toBase58(),
    owner: owner.publicKey.toBase58(),
    side: 'back',
    activeAmount: 10n,
    pendingAmount: 0n,
    refundableAmount: 0n,
    settlementBaseEntitlement: 10n,
    settlementProcessed: true,
    nextLotNonce: 1n,
    claimed: overrides.claimed ?? false,
    totalPaidAmount: 10n,
    createdSlot: 10n,
    updatedSlot: 20n,
  };
  return {
    programId,
    owner,
    mint,
    marketPda,
    positionPda,
    market,
    position,
    blockhash: Keypair.generate().publicKey.toBase58(),
  };
}

function fixtureRpc(fixture: ReturnType<typeof claimFixture>): DirectClaimRpc & { readonly engineRequests: number } {
  let submitted = false;
  return {
    engineRequests: 0,
    async getAccountInfo(address) {
      if (address.equals(fixture.marketPda)) return accountInfo(encodeMarket(fixture.market), fixture.programId);
      if (address.equals(fixture.positionPda)) {
        return accountInfo(encodePosition({ ...fixture.position, claimed: submitted || fixture.position.claimed }), fixture.programId);
      }
      if (address.toBase58() === fixture.market.vault) {
        return fixture.market.asset === 'sol'
          ? accountInfo(new Uint8Array(), fixture.programId)
          : tokenAccountInfo(fixture.mint, fixture.marketPda);
      }
      if (address.equals(fixture.mint)) return mintAccountInfo(fixture.mint);
      return null;
    },
    async getBlockHeight() { return 10; },
    async getBalance() { return 10_000_000; },
    async getGenesisHash() { return GENESIS; },
    async getLatestBlockhash() { return { blockhash: fixture.blockhash, lastValidBlockHeight: 100 }; },
    async isBlockhashValid() { return true; },
    async sendRawTransaction() { submitted = true; return '1'.repeat(64); },
    async getSignatureStatus() {
      return { slot: 100, confirmations: null, err: null, confirmationStatus: 'finalized' };
    },
  };
}

function accountInfo(data: Uint8Array, owner: PublicKey): AccountInfo<Buffer> {
  return { data: Buffer.from(data), executable: false, lamports: 1, owner, rentEpoch: 0 };
}

function tokenAccountInfo(mint: PublicKey, owner: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({
    mint,
    owner,
    amount: 100n,
    delegateOption: 0,
    delegate: PublicKey.default,
    state: AccountState.Initialized,
    isNativeOption: 0,
    isNative: 0n,
    delegatedAmount: 0n,
    closeAuthorityOption: 0,
    closeAuthority: PublicKey.default,
  }, data);
  return accountInfo(data, TOKEN_PROGRAM_ID);
}

function mintAccountInfo(mintAuthority: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({
    mintAuthorityOption: 1,
    mintAuthority,
    supply: 1_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  }, data);
  return accountInfo(data, TOKEN_PROGRAM_ID);
}

function encodeMarket(market: MarketAccount): Uint8Array {
  return new BorshWriter()
    .bytes(Uint8Array.from(ESCROW_ACCOUNT_DISCRIMINATORS.Market))
    .u8(market.version, 'version').u8(market.bump, 'bump')
    .bytes(uuidToBytes(market.marketUuid)).u64(market.fixtureId, 'fixture')
    .bytes(market.claimSpecificationHash).bytes(market.displayTermsHash).bytes(market.oddsMessageHash)
    .bytes(market.marketDocumentHash).i64(market.quoteTimestamp, 'quote')
    .u32(market.probabilityPpm, 'probability').u32(market.ratioMilli, 'ratio')
    .u8(market.asset === 'sol' ? 0 : 1, 'asset')
    .publicKey(market.tokenMint ?? PublicKey.default).u16(market.feeBps, 'fee')
    .u8(market.state === 'settled' ? 4 : 5, 'state').bool(market.replay, 'replay')
    .publicKey(market.residualRecipient).i64(market.createdTimestamp, 'created')
    .i64(market.inPlayStartTimestamp, 'in play').u64(market.activationDelaySeconds, 'delay')
    .i64(market.positionCutoffTimestamp, 'cutoff').i64(market.resolutionDeadline, 'deadline')
    .u64(market.oracleSetEpoch, 'oracle').u64(market.eventEpoch, 'event')
    .u64(market.activeBackTotal, 'active back').u64(market.activeDoubtTotal, 'active doubt')
    .u64(market.pendingBackTotal, 'pending back').u64(market.pendingDoubtTotal, 'pending doubt')
    .u64(market.finalMatchedBackTotal, 'matched back').u64(market.finalMatchedDoubtTotal, 'matched doubt')
    .u64(market.finalForfeitedTotal, 'forfeited').u64(market.settlementProcessedPositionCount, 'processed')
    .u8(1, 'outcome').bytes(market.settlementEvidenceHash ?? bytes(0))
    .u64(market.positionCount, 'positions').u64(market.claimedPositionCount, 'claimed positions')
    .publicKey(market.vault).u8(market.vaultBump, 'vault bump').finish();
}

function encodePosition(position: UserPositionAccount): Uint8Array {
  return new BorshWriter()
    .bytes(Uint8Array.from(ESCROW_ACCOUNT_DISCRIMINATORS.UserPosition))
    .u8(position.version, 'version').u8(position.bump, 'bump')
    .publicKey(position.market).publicKey(position.owner).u8(position.side === 'back' ? 0 : 1, 'side')
    .u64(position.activeAmount, 'active').u64(position.pendingAmount, 'pending')
    .u64(position.refundableAmount, 'refundable').u64(position.settlementBaseEntitlement, 'base')
    .bool(position.settlementProcessed, 'processed').u64(position.nextLotNonce, 'nonce')
    .bool(position.claimed, 'claimed').u64(position.totalPaidAmount, 'paid')
    .u64(position.createdSlot, 'created').u64(position.updatedSlot, 'updated').finish();
}

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}
