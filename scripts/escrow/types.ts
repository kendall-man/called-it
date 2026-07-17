export const EXIT = {
  ok: 0,
  usage: 2,
  input: 3,
  mismatch: 4,
  rpc: 5,
  gate: 6,
  unhealthy: 7,
  internal: 8,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type Network = 'localnet' | 'devnet' | 'testnet' | 'mainnet-beta';

export interface BuildManifest {
  readonly schemaVersion: 1;
  readonly sourceCommit: string;
  readonly programId: string;
  readonly sbfSha256: string;
  readonly idlSha256: string;
  readonly sourceSha256: string;
  readonly lockSha256: string;
}

export interface ReleaseConfigExpectation {
  readonly custodyVersion: number;
  readonly paused: boolean;
  readonly configAuthority: string;
  readonly pauseAuthority: string;
  readonly marketCreationAuthority: string;
  readonly feedOperatorAuthority: string;
  readonly oracleSet: string;
  readonly relayerFeePayer: string;
  readonly residualRecipient: string;
  readonly canonicalUsdcMint: string;
  readonly allowedTokenProgram: string;
  readonly minSolPosition: string;
  readonly maxSolPosition: string;
  readonly minUsdcPosition: string;
  readonly maxUsdcPosition: string;
  readonly maxMarketDurationSeconds: string;
  readonly maxResolutionDelaySeconds: string;
}

export interface OracleSetExpectation {
  readonly address: string;
  readonly custodyVersion: number;
  readonly epoch: string;
  readonly signers: readonly [string, string, string];
  readonly threshold: 2;
  readonly activationSlot: string;
  readonly retirementSlot: string | null;
}

export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly network: Network;
  readonly clusterGenesisHash: string;
  readonly programId: string;
  readonly upgradeableLoaderProgramId: string;
  readonly programDataAddress: string;
  readonly upgradeAuthority: string;
  readonly configPda: string;
  readonly build: BuildManifest;
  readonly config: ReleaseConfigExpectation;
  readonly oracleSet: OracleSetExpectation;
}

export interface RpcAccount {
  readonly owner: string;
  readonly executable: boolean;
  readonly lamports: number;
  readonly data: Buffer;
}

export interface RpcReader {
  genesisHash(): Promise<string>;
  account(address: string): Promise<RpcAccount>;
}

export interface FinalizedTransaction {
  readonly slot: number;
  readonly blockTime: number;
  readonly accountKeys: readonly string[];
}

export interface EvidenceRpcReader extends RpcReader {
  finalizedTransaction(signature: string): Promise<FinalizedTransaction>;
}

export interface ProtocolConfigAccount {
  readonly version: number;
  readonly bump: number;
  readonly paused: boolean;
  readonly configAuthority: string;
  readonly pauseAuthority: string;
  readonly marketCreationAuthority: string;
  readonly feedOperatorAuthority: string;
  readonly oracleSet: string;
  readonly relayerFeePayer: string;
  readonly residualRecipient: string;
  readonly clusterGenesisHash: string;
  readonly canonicalUsdcMint: string;
  readonly allowedTokenProgram: string;
  readonly maxSolPosition: string;
  readonly maxUsdcPosition: string;
  readonly minSolPosition: string;
  readonly minUsdcPosition: string;
  readonly maxMarketDurationSeconds: string;
  readonly maxResolutionDelaySeconds: string;
}

export interface OracleSetAccount {
  readonly version: number;
  readonly bump: number;
  readonly epoch: string;
  readonly signers: readonly string[];
  readonly threshold: number;
  readonly activationSlot: string;
  readonly retirementSlot: string | null;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly checks: readonly string[];
}

export class EscrowControlError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
  ) {
    super(message);
    this.name = 'EscrowControlError';
  }
}
