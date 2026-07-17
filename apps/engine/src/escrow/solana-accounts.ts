import { bytesToHex } from '@calledit/solana';
import {
  decodeMarketAccount,
  decodeOracleSetAccount,
  decodePositionLotAccount,
  decodeProtocolConfigAccount,
  decodeUserPositionAccount,
  type MarketAccount,
  type OracleSetAccount,
  type PositionLotAccount,
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
import type { EscrowRecoveryChain } from './recovery-relayer.js';
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

  async lot(address: string): Promise<DecodedEscrowAccount<PositionLotAccount> | null> {
    const account = await this.raw(address);
    return account === null ? null : { ...account, value: decodePositionLotAccount(account.value) };
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
    replay: account.value.replay,
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

export class SolanaEscrowRecoveryChain implements EscrowRecoveryChain {
  constructor(
    private readonly rpc: EscrowSolanaRpc,
    private readonly accounts: SolanaEscrowAccountReader,
  ) {}

  genesisHash() { return this.rpc.genesisHash(); }
  latestBlockhash() { return this.rpc.latestBlockhash(); }
  config(address: string) { return this.accounts.config(address); }
  market(address: string) { return this.accounts.market(address); }
  position(address: string) { return this.accounts.position(address); }
  lot(address: string) { return this.accounts.lot(address); }
  oracleSet(address: string) { return this.accounts.oracleSet(address); }
  async accountExists(address: string) { return await this.accounts.raw(address) !== null; }
  async unixTimestamp() {
    const slot = await this.accounts.connection.getSlot('finalized');
    const timestamp = await this.accounts.connection.getBlockTime(slot);
    if (timestamp === null || !Number.isSafeInteger(timestamp)) {
      throw new TypeError('finalized Solana block time unavailable');
    }
    return BigInt(timestamp);
  }
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
    // Public devnet aggressively rate-limits bursts. Keep genesis separate,
    // then load every initialization account in one consistent finalized RPC
    // snapshot instead of issuing six concurrent account requests.
    const genesisHash = await this.rpc.genesisHash();
    const [program, configAccount, oracleAccount, market] =
      await this.accounts.connection.getMultipleAccountsInfo([
        new PublicKey(input.programId),
        new PublicKey(input.protocolConfigPda),
        new PublicKey(input.oracleSetPda),
        new PublicKey(input.marketPda),
      ], 'finalized');
    if (program == null || configAccount == null || oracleAccount == null) {
      throw new TypeError('escrow initialization account unavailable');
    }
    const config = decodeProtocolConfigAccount(Uint8Array.from(configAccount.data));
    const oracle = decodeOracleSetAccount(Uint8Array.from(oracleAccount.data));
    return {
      genesisHash,
      programExecutable: program.executable,
      programId: input.programId,
      configPda: input.protocolConfigPda,
      configOwnerProgramId: configAccount.owner.toBase58(),
      paused: config.paused,
      configGenesisHashHex: bytesToHex(config.clusterGenesisHash),
      canonicalUsdcMint: config.canonicalUsdcMint,
      marketCreationAuthority: config.marketCreationAuthority,
      relayerFeePayer: config.relayerFeePayer,
      oracleSetPda: config.oracleSet,
      oracleOwnerProgramId: oracleAccount.owner.toBase58(),
      oracleSetEpoch: oracle.epoch,
      marketExists: market !== null,
    };
  }

  latestBlockhash() { return this.rpc.latestBlockhash(); }
}
