import { PublicKey } from '@solana/web3.js';
import { CanonicalWriter, uuidToBytes } from './codec.js';

export const ESCROW_PDA_SEEDS = {
  config: 'config',
  oracleSet: 'oracle-set',
  market: 'market',
  position: 'position',
  lot: 'lot',
  solVault: 'vault',
} as const;

export const CLASSIC_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export interface DerivedPda {
  readonly publicKey: PublicKey;
  readonly address: string;
  readonly bump: number;
}

type PublicKeyInput = PublicKey | string;
const seed = (value: string) => new TextEncoder().encode(value);
const key = (value: PublicKeyInput) => typeof value === 'string' ? new PublicKey(value) : value;

function derive(programId: PublicKeyInput, seeds: readonly Uint8Array[]): DerivedPda {
  const [publicKey, bump] = PublicKey.findProgramAddressSync([...seeds], key(programId));
  return { publicKey, address: publicKey.toBase58(), bump };
}

function u64Seed(value: bigint, name: string): Uint8Array {
  return new CanonicalWriter().u64(value, name).finish();
}

export function deriveProtocolConfigPda(programId: PublicKeyInput): DerivedPda {
  return derive(programId, [seed(ESCROW_PDA_SEEDS.config)]);
}

export function deriveOracleSetPda(programId: PublicKeyInput, epoch: bigint): DerivedPda {
  return derive(programId, [seed(ESCROW_PDA_SEEDS.oracleSet), u64Seed(epoch, 'oracle-set epoch')]);
}

export function deriveMarketPda(programId: PublicKeyInput, marketUuid: string): DerivedPda {
  return derive(programId, [seed(ESCROW_PDA_SEEDS.market), uuidToBytes(marketUuid)]);
}

export function deriveUserPositionPda(
  programId: PublicKeyInput,
  market: PublicKeyInput,
  owner: PublicKeyInput,
): DerivedPda {
  return derive(programId, [seed(ESCROW_PDA_SEEDS.position), key(market).toBytes(), key(owner).toBytes()]);
}

export function derivePositionLotPda(
  programId: PublicKeyInput,
  market: PublicKeyInput,
  owner: PublicKeyInput,
  nonce: bigint,
): DerivedPda {
  return derive(programId, [
    seed(ESCROW_PDA_SEEDS.lot),
    key(market).toBytes(),
    key(owner).toBytes(),
    u64Seed(nonce, 'lot nonce'),
  ]);
}

export function deriveSolVaultPda(programId: PublicKeyInput, market: PublicKeyInput): DerivedPda {
  return derive(programId, [seed(ESCROW_PDA_SEEDS.solVault), key(market).toBytes()]);
}

export function deriveUsdcVaultAddress(market: PublicKeyInput, mint: PublicKeyInput): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [key(market).toBytes(), CLASSIC_TOKEN_PROGRAM_ID.toBytes(), key(mint).toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}
