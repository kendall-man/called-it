import { bytesToHex } from '@calledit/solana';
import {
  decodeMarketAccount,
  decodeOracleSetAccount,
  decodeProtocolConfigAccount,
  decodeUserPositionAccount,
  type MarketAccount,
  type OracleSetAccount,
  type ProtocolConfigAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import type { EscrowMarketInitializationChain } from './market-initializer.js';
import type {
  EscrowMarketInitializationObservation,
  EscrowMarketRelayerChain,
} from './market-relayer.js';
import type {
  EscrowPlacementChain,
} from './placement-types.js';
import type { EscrowSolanaRpc } from './solana-rpc.js';

export interface DecodedEscrowAccount<T> {
  readonly address: string;
  readonly ownerProgramId: string;
  readonly lamports: bigint;
  readonly value: T;
}

export class SolanaEscrowAccountReader {
  constructor(readonly connection: Connection) {}

  private async account(address: string): Promise<AccountInfo<Buffer> | null> {
    return this.connection.getAccountInfo(new PublicKey(address), 'finalized');
  }

  async raw(address: string): Promise<DecodedEscrowAccount<Uint8Array> | null> {
    const account = await this.account(address);
    if (account === null) return null;
    return {
      address,
      ownerProgramId: account.owner.toBase58(),
      lamports: BigInt(account.lamports),
      value: Uint8Array.from(account.data),
    };
  }

  async market(address: string): Promise<DecodedEscrowAccount<MarketAccount> | null> {
    const account = await this.raw(address);
    return account === null ? null : { ...account, value: decodeMarketAccount(account.value) };
  }

  async position(address: string): Promise<DecodedEscrowAccount<UserPositionAccount> | null> {
    const account = await this.raw(address);
    return account === null ? null : { ...account, value: decodeUserPositionAccount(account.value) };
  }

  async config(address: string): Promise<DecodedEscrowAccount<ProtocolConfigAccount> | null> {
    const account = await this.raw(address);
    return account === null ? null : { ...account, value: decodeProtocolConfigAccount(account.value) };
  }

  async oracleSet(address: string): Promise<DecodedEscrowAccount<OracleSetAccount> | null> {
    const account = await this.raw(address);
    return account === null ? null : { ...account, value: decodeOracleSetAccount(account.value) };
  }
}

function marketRecord(account: DecodedEscrowAccount<MarketAccount>, custodyMode: 'escrow') {
  return {
    custodyMode,
    ownerProgramId: account.ownerProgramId,
    marketPda: account.address,
    marketId: account.value.marketUuid,
    documentHashHex: bytesToHex(account.value.marketDocumentHash),
    asset: account.value.asset,
    tokenMint: account.value.asset === 'usdc' ? account.value.tokenMint : null,
    ratioMilli: account.value.ratioMilli,
    eventEpoch: account.value.eventEpoch,
    oracleSetEpoch: account.value.oracleSetEpoch,
    positionCutoffTimestamp: account.value.positionCutoffTimestamp,
    state: account.value.state,
  } as const;
}

export class SolanaEscrowPlacementChain implements EscrowPlacementChain {
  constructor(
    private readonly rpc: EscrowSolanaRpc,
    private readonly accounts: SolanaEscrowAccountReader,
  ) {}

  async readMarket(marketPda: string) {
    const account = await this.accounts.market(marketPda);
    return account === null ? null : marketRecord(account, 'escrow');
  }

  async readPosition(positionPda: string) {
    const account = await this.accounts.position(positionPda);
    if (account === null) return null;
    const marketPda = account.value.market;
    return {
      ownerProgramId: account.ownerProgramId,
      positionPda: account.address,
      marketPda,
      ownerPubkey: account.value.owner,
      side: account.value.side,
      nextLotNonce: account.value.nextLotNonce,
      totalPaidAmount: account.value.totalPaidAmount,
      claimed: account.value.claimed,
    };
  }

  latestBlockhash() { return this.rpc.latestBlockhash(); }
  blockHeight() { return this.rpc.blockHeight(); }
  genesisHash() { return this.rpc.genesisHash(); }
  isBlockhashValid(blockhash: string) { return this.rpc.isBlockhashValid(blockhash); }
}

export class SolanaMarketInitializationReader implements EscrowMarketInitializationChain {
  constructor(private readonly accounts: SolanaEscrowAccountReader) {}

  async readMarket(marketPda: string) {
    const account = await this.accounts.market(marketPda);
    if (account === null) return null;
    return {
      ownerProgramId: account.ownerProgramId,
      marketPda,
      vaultPda: account.value.vault,
      documentHashHex: bytesToHex(account.value.marketDocumentHash),
      asset: account.value.asset,
      tokenMint: account.value.asset === 'usdc' ? account.value.tokenMint : null,
      oracleSetEpoch: account.value.oracleSetEpoch,
      ratioMilli: account.value.ratioMilli,
      state: account.value.state,
    };
  }
}

export class SolanaMarketRelayerChain implements EscrowMarketRelayerChain {
  constructor(
    private readonly rpc: EscrowSolanaRpc,
    private readonly accounts: SolanaEscrowAccountReader,
  ) {}

  async inspectInitialization(input: {
    readonly genesisHash: string;
    readonly programId: string;
    readonly protocolConfigPda: string;
    readonly oracleSetPda: string;
    readonly marketPda: string;
    readonly vaultPda: string;
  }): Promise<EscrowMarketInitializationObservation> {
    const [genesisHash, program, config, oracle, market] = await Promise.all([
      this.rpc.genesisHash(),
      this.accounts.raw(input.programId),
      this.accounts.config(input.protocolConfigPda),
      this.accounts.oracleSet(input.oracleSetPda),
      this.accounts.raw(input.marketPda),
    ]);
    if (program === null || config === null || oracle === null) {
      throw new TypeError('escrow initialization account unavailable');
    }
    const programInfo = await this.accounts.connection.getAccountInfo(
      new PublicKey(input.programId),
      'finalized',
    );
    return {
      genesisHash,
      programExecutable: programInfo?.executable === true,
      programId: input.programId,
      configPda: input.protocolConfigPda,
      configOwnerProgramId: config.ownerProgramId,
      paused: config.value.paused,
      configGenesisHashHex: bytesToHex(config.value.clusterGenesisHash),
      canonicalUsdcMint: config.value.canonicalUsdcMint,
      marketCreationAuthority: config.value.marketCreationAuthority,
      relayerFeePayer: config.value.relayerFeePayer,
      oracleSetPda: config.value.oracleSet,
      oracleOwnerProgramId: oracle.ownerProgramId,
      oracleSetEpoch: oracle.value.epoch,
      marketExists: market !== null,
    };
  }

  latestBlockhash() { return this.rpc.latestBlockhash(); }
}
