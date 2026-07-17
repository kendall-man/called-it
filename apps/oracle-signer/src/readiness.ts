import {
  compiledEscrowProgramIdForNetwork,
  decodeOracleSetAccount,
  deriveOracleSetPda,
} from '@calledit/escrow-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import type { OracleSignerEnv } from './env.js';

const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

export type OracleReadinessReason =
  | 'rpc_unavailable'
  | 'genesis_mismatch'
  | 'program_unavailable'
  | 'program_not_executable'
  | 'program_identity_mismatch'
  | 'program_loader_mismatch'
  | 'program_data_mismatch'
  | 'program_not_upgradeable'
  | 'program_upgrade_authority_mismatch'
  | 'oracle_set_unavailable'
  | 'oracle_set_owner_mismatch'
  | 'oracle_set_epoch_mismatch'
  | 'oracle_set_inactive'
  | 'oracle_signer_not_member'
  | 'journal_unavailable';

export interface OracleReadinessAccount {
  readonly data: Uint8Array;
  readonly executable: boolean;
  readonly owner: PublicKey;
}

export interface OracleReadinessChainReader {
  genesisHash(): Promise<string>;
  finalizedSlot(): Promise<bigint>;
  account(address: PublicKey): Promise<OracleReadinessAccount | null>;
}

export interface OracleReadinessJournal {
  checkPersistence(): Promise<void>;
}

export interface OracleReadinessProbe {
  check(): Promise<readonly OracleReadinessReason[]>;
}

function createReadinessChainReader(rpcUrl: string): OracleReadinessChainReader {
  const connection = new Connection(rpcUrl, 'finalized');
  return {
    async genesisHash() {
      return connection.getGenesisHash();
    },
    async finalizedSlot() {
      return BigInt(await connection.getSlot('finalized'));
    },
    async account(address) {
      const value = await connection.getAccountInfo(address, { commitment: 'finalized' });
      return value === null ? null : {
        data: Uint8Array.from(value.data),
        executable: value.executable,
        owner: value.owner,
      };
    },
  };
}

function programDataAddress(program: PublicKey, account: OracleReadinessAccount): PublicKey | null {
  if (account.data.length !== 36 || Buffer.from(account.data).readUInt32LE(0) !== 2) return null;
  return new PublicKey(account.data.slice(4, 36));
}

function upgradeAuthority(account: OracleReadinessAccount): PublicKey | null {
  if (
    account.data.length < 45 ||
    Buffer.from(account.data).readUInt32LE(0) !== 3 ||
    account.data[12] !== 1
  ) return null;
  const authority = new PublicKey(account.data.slice(13, 45));
  return authority.equals(PublicKey.default) ? null : authority;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

async function chainReasons(
  env: OracleSignerEnv,
  chain: OracleReadinessChainReader,
): Promise<readonly OracleReadinessReason[]> {
  const compiledProgramId = compiledEscrowProgramIdForNetwork(env.ORACLE_SIGNER_NETWORK);
  if (compiledProgramId === null || env.ESCROW_PROGRAM_ID !== compiledProgramId) {
    return ['program_identity_mismatch'];
  }

  let genesis: string;
  try {
    genesis = await chain.genesisHash();
  } catch {
    return ['rpc_unavailable'];
  }
  if (genesis !== env.ESCROW_GENESIS_HASH) return ['genesis_mismatch'];

  const program = new PublicKey(env.ESCROW_PROGRAM_ID);
  let programAccount: OracleReadinessAccount | null;
  try {
    programAccount = await chain.account(program);
  } catch {
    return ['rpc_unavailable'];
  }
  if (programAccount === null) return ['program_unavailable'];
  if (!programAccount.executable) return ['program_not_executable'];
  if (!programAccount.owner.equals(UPGRADEABLE_LOADER)) return ['program_loader_mismatch'];

  const canonicalProgramData = PublicKey.findProgramAddressSync(
    [program.toBuffer()],
    UPGRADEABLE_LOADER,
  )[0];
  const linkedProgramData = programDataAddress(program, programAccount);
  if (linkedProgramData === null || !linkedProgramData.equals(canonicalProgramData)) {
    return ['program_data_mismatch'];
  }

  let programDataAccount: OracleReadinessAccount | null;
  try {
    programDataAccount = await chain.account(canonicalProgramData);
  } catch {
    return ['rpc_unavailable'];
  }
  if (
    programDataAccount === null || programDataAccount.executable ||
    !programDataAccount.owner.equals(UPGRADEABLE_LOADER)
  ) return ['program_data_mismatch'];
  const observedUpgradeAuthority = upgradeAuthority(programDataAccount);
  if (observedUpgradeAuthority === null) return ['program_not_upgradeable'];
  if (!observedUpgradeAuthority.equals(new PublicKey(env.ESCROW_UPGRADE_AUTHORITY))) {
    return ['program_upgrade_authority_mismatch'];
  }

  let slot: bigint;
  let oracleAccount: OracleReadinessAccount | null;
  const oracleAddress = deriveOracleSetPda(program, env.ESCROW_ORACLE_SET_EPOCH).publicKey;
  try {
    [slot, oracleAccount] = await Promise.all([
      chain.finalizedSlot(),
      chain.account(oracleAddress),
    ]);
  } catch {
    return ['rpc_unavailable'];
  }
  if (oracleAccount === null) return ['oracle_set_unavailable'];
  if (oracleAccount.executable || !oracleAccount.owner.equals(program)) {
    return ['oracle_set_owner_mismatch'];
  }

  let oracleSet;
  try {
    oracleSet = decodeOracleSetAccount(oracleAccount.data);
  } catch {
    return ['oracle_set_epoch_mismatch'];
  }
  if (
    oracleSet.epoch !== env.ESCROW_ORACLE_SET_EPOCH ||
    oracleSet.signatureThreshold !== 2 || oracleSet.signers.length !== 3 ||
    !unique(oracleSet.signers)
  ) return ['oracle_set_epoch_mismatch'];
  if (
    oracleSet.activationSlot > slot
  ) return ['oracle_set_inactive'];
  if (!oracleSet.signers.includes(env.signer.publicKey.toBase58())) {
    return ['oracle_signer_not_member'];
  }
  return [];
}

export function createOracleReadinessProbe(
  env: OracleSignerEnv,
  journal: OracleReadinessJournal,
  chain: OracleReadinessChainReader = createReadinessChainReader(env.SOLANA_RPC_URL),
): OracleReadinessProbe {
  return {
    async check() {
      const [chainResult, journalResult] = await Promise.all([
        chainReasons(env, chain),
        journal.checkPersistence().then(
          () => [] as const,
          () => ['journal_unavailable'] as const,
        ),
      ]);
      return [...chainResult, ...journalResult];
    },
  };
}
