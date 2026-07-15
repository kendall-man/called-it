import type { Keypair, PublicKey } from '@solana/web3.js';
import type { MarketDocumentV1 } from '@calledit/escrow-sdk';

export interface RoleKeys {
  readonly configAuthority: Keypair;
  readonly pauseAuthority: Keypair;
  readonly marketAuthority: Keypair;
  readonly feedAuthority: Keypair;
  readonly relayer: Keypair;
  readonly residualRecipient: Keypair;
  readonly mintAuthority: Keypair;
  readonly users: readonly [Keypair, Keypair, Keypair, Keypair];
  readonly oracles: readonly [Keypair, Keypair, Keypair];
}

export interface BootstrapContext {
  readonly rpcUrl: string;
  readonly programId: PublicKey;
  readonly upgradeAuthority: Keypair;
  readonly roles: RoleKeys;
  readonly canonicalUsdcMint: PublicKey;
  readonly genesisHash: string;
  readonly genesisBytes: Uint8Array;
  readonly oracleEpoch: bigint;
  readonly oracleSet: PublicKey;
}

export interface OpenedMarket {
  readonly document: MarketDocumentV1;
  readonly documentHash: Uint8Array;
  readonly market: PublicKey;
  readonly vault: PublicKey;
}

export interface PlacedPosition {
  readonly owner: Keypair;
  readonly market: OpenedMarket;
  readonly position: PublicKey;
  readonly lot: PublicKey;
  readonly amount: bigint;
  readonly side: 'back' | 'doubt';
  readonly nonce: bigint;
  readonly signature: string;
  readonly lastValidBlockHeight: bigint;
  readonly signedBytes: Uint8Array;
}

export interface ScenarioResult {
  readonly bootstrap: true;
  readonly placements: true;
  readonly antiSnipe: true;
  readonly settlement: true;
  readonly voids: true;
  readonly replayPath: true;
  readonly recovery: true;
  readonly closeGuards: true;
}
