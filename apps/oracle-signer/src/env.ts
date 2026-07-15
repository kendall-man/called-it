import { compiledEscrowProgramIdForNetwork } from '@calledit/escrow-sdk';
import { base58Decode } from '@calledit/solana';
import { Keypair, PublicKey } from '@solana/web3.js';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  ORACLE_SIGNER_NETWORK: z.enum(['devnet', 'mainnet-beta']),
  ORACLE_SIGNER_ALLOW_MAINNET: z.enum(['true', 'false']).default('false'),
  ORACLE_SIGNER_BEARER_TOKEN: z.string().min(32).max(512),
  ORACLE_SIGNER_KEYPAIR_B58: z.string().min(32),
  ORACLE_SIGNER_JOURNAL_PATH: z.string().min(1).default('/data/oracle-signatures.jsonl'),
  SOLANA_RPC_URL: z.string().url(),
  ESCROW_PROGRAM_ID: z.string().min(32),
  ESCROW_UPGRADE_AUTHORITY: z.string().min(32),
  ESCROW_GENESIS_HASH: z.string().min(32),
  ESCROW_ORACLE_SET_EPOCH: z.coerce.bigint().nonnegative(),
  TXLINE_API_BASE: z.string().url(),
  TXLINE_GUEST_JWT: z.string().min(1),
  TXLINE_API_TOKEN: z.string().min(1),
  ORACLE_SIGNER_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(120).default(30),
});

const GENESIS_BY_NETWORK = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

export interface OracleSignerEnv extends Omit<z.infer<typeof schema>, 'ORACLE_SIGNER_KEYPAIR_B58'> {
  readonly signer: Keypair;
}

export function loadOracleSignerEnv(source: NodeJS.ProcessEnv = process.env): OracleSignerEnv {
  const parsed = schema.parse(source);
  if (parsed.ORACLE_SIGNER_NETWORK === 'mainnet-beta' && parsed.ORACLE_SIGNER_ALLOW_MAINNET !== 'true') {
    throw new Error('mainnet oracle signing is disabled');
  }
  if (parsed.ESCROW_GENESIS_HASH !== GENESIS_BY_NETWORK[parsed.ORACLE_SIGNER_NETWORK]) {
    throw new Error('oracle signer network and genesis hash do not match');
  }
  const compiledProgramId = compiledEscrowProgramIdForNetwork(parsed.ORACLE_SIGNER_NETWORK);
  if (compiledProgramId === null) {
    throw new Error('oracle signer compiled program identity is unavailable for this network');
  }
  let programId: string;
  let upgradeAuthority: string;
  try {
    programId = new PublicKey(parsed.ESCROW_PROGRAM_ID).toBase58();
    upgradeAuthority = new PublicKey(parsed.ESCROW_UPGRADE_AUTHORITY).toBase58();
  } catch {
    throw new Error('oracle signer deployment address is invalid');
  }
  if (upgradeAuthority === PublicKey.default.toBase58()) {
    throw new Error('oracle signer upgrade authority is invalid');
  }
  if (programId !== compiledProgramId) {
    throw new Error('oracle signer program ID does not match compiled identity');
  }
  const secret = base58Decode(parsed.ORACLE_SIGNER_KEYPAIR_B58);
  if (secret.length !== 64) throw new Error('oracle signer keypair is invalid');
  const signer = Keypair.fromSecretKey(secret);
  const { ORACLE_SIGNER_KEYPAIR_B58: _secret, ...safe } = parsed;
  return {
    ...safe,
    ESCROW_PROGRAM_ID: programId,
    ESCROW_UPGRADE_AUTHORITY: upgradeAuthority,
    signer,
  };
}
