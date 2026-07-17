import { base58Encode } from '@calledit/solana';
import {
  decodeMarketAccount,
  decodeUserPositionAccount,
  CLASSIC_TOKEN_PROGRAM_ID,
  deriveMarketPda,
  deriveSolVaultPda,
  deriveUsdcVaultAddress,
  ESCROW_ACCOUNT_DISCRIMINATORS,
} from '@calledit/escrow-sdk';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import {
  EscrowReconciliationError,
  type EscrowReconciliationChain,
  type EscrowReconciliationPosition,
} from './reconciler.js';

const POSITION_MARKET_OFFSET = 10;
const TOKEN_ACCOUNT_LENGTH = 165;
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

function requireAccount(
  account: AccountInfo<Buffer> | null,
  expectedOwner: PublicKey,
): AccountInfo<Buffer> {
  if (account === null || !account.owner.equals(expectedOwner)) {
    throw new EscrowReconciliationError('chain_identity_mismatch');
  }
  return account;
}

function tokenAmount(account: AccountInfo<Buffer>, mint: PublicKey): bigint {
  if (
    !account.owner.equals(CLASSIC_TOKEN_PROGRAM_ID) ||
    account.data.length !== TOKEN_ACCOUNT_LENGTH ||
    !account.data.subarray(0, 32).equals(mint.toBuffer()) ||
    account.data[108] !== 1
  ) {
    throw new EscrowReconciliationError('chain_identity_mismatch');
  }
  return account.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
}

export class SolanaEscrowReconciliationChain implements EscrowReconciliationChain {
  private readonly program: PublicKey;
  private readonly usdcMint: PublicKey;

  constructor(
    private readonly connection: Connection,
    expected: { readonly programId: string; readonly canonicalUsdcMint: string },
  ) {
    this.program = new PublicKey(expected.programId);
    this.usdcMint = new PublicKey(expected.canonicalUsdcMint);
  }

  async readFinalizedSnapshot(input: {
    readonly marketPda: string;
    readonly vaultPda: string;
    readonly asset: 'sol' | 'usdc';
  }) {
    const minimumSlot = await this.connection.getSlot('finalized');
    const marketKey = new PublicKey(input.marketPda);
    const vaultKey = new PublicKey(input.vaultPda);
    const marketResponse = await this.connection.getAccountInfoAndContext(marketKey, {
      commitment: 'finalized',
      minContextSlot: minimumSlot,
    });
    const marketAccount = requireAccount(marketResponse.value, this.program);
    const market = decodeMarketAccount(Uint8Array.from(marketAccount.data));
    if (
      deriveMarketPda(this.program, market.marketUuid).address !== input.marketPda ||
      market.vault !== input.vaultPda || market.asset !== input.asset
    ) throw new EscrowReconciliationError('chain_identity_mismatch');

    const expectedVault = input.asset === 'sol'
      ? deriveSolVaultPda(this.program, marketKey).address
      : deriveUsdcVaultAddress(marketKey, this.usdcMint).toBase58();
    const expectedMint = input.asset === 'usdc' ? this.usdcMint.toBase58() : null;
    if (input.vaultPda !== expectedVault || market.tokenMint !== expectedMint) {
      throw new EscrowReconciliationError('chain_identity_mismatch');
    }

    const positionsResponse = await this.connection.getProgramAccounts(this.program, {
      commitment: 'finalized',
      minContextSlot: minimumSlot,
      withContext: true,
      filters: [
        { memcmp: { offset: 0, bytes: base58Encode(Uint8Array.from(ESCROW_ACCOUNT_DISCRIMINATORS.UserPosition)) } },
        { memcmp: { offset: POSITION_MARKET_OFFSET, bytes: marketKey.toBase58() } },
      ],
    });
    const positions: EscrowReconciliationPosition[] = positionsResponse.value.map(({ pubkey, account }) => {
      const value = decodeUserPositionAccount(Uint8Array.from(account.data));
      if (value.market !== input.marketPda) throw new EscrowReconciliationError('chain_identity_mismatch');
      return {
        ownerProgramId: account.owner.toBase58(),
        positionPda: pubkey.toBase58(),
        ownerPubkey: value.owner,
        side: value.side,
        activeAmount: value.activeAmount,
        pendingAmount: value.pendingAmount,
        refundableAmount: value.refundableAmount,
        nextLotNonce: value.nextLotNonce,
        totalPaidAmount: value.totalPaidAmount,
        claimed: value.claimed,
      };
    });

    const vaultResponse = await this.connection.getAccountInfoAndContext(vaultKey, {
      commitment: 'finalized',
      minContextSlot: minimumSlot,
    });
    let vaultPrincipalAtomic: bigint;
    if (input.asset === 'sol') {
      const vault = requireAccount(vaultResponse.value, this.program);
      const reserve = BigInt(await this.connection.getMinimumBalanceForRentExemption(vault.data.length, 'finalized'));
      vaultPrincipalAtomic = BigInt(vault.lamports) - reserve;
    } else {
      const vault = vaultResponse.value;
      if (vault === null) throw new EscrowReconciliationError('chain_identity_mismatch');
      vaultPrincipalAtomic = tokenAmount(vault, this.usdcMint);
    }
    if (vaultPrincipalAtomic < 0n) throw new EscrowReconciliationError('invalid_snapshot');
    return {
      sourceSlot: BigInt(Math.max(marketResponse.context.slot, positionsResponse.context.slot, vaultResponse.context.slot)),
      ownerProgramId: marketAccount.owner.toBase58(),
      marketId: market.marketUuid,
      marketPda: input.marketPda,
      vaultPda: input.vaultPda,
      asset: market.asset,
      tokenMint: market.tokenMint,
      state: market.state,
      eventEpoch: market.eventEpoch,
      ratioMilli: BigInt(market.ratioMilli),
      settlementOutcome: market.settlementOutcome,
      vaultPrincipalAtomic,
      positions,
    };
  }
}
