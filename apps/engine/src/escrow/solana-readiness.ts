import { deriveProtocolConfigPda } from '@calledit/escrow-sdk';
import { PublicKey, type Connection } from '@solana/web3.js';
import type {
  EscrowDeploymentExpectation,
  EscrowDeploymentObservation,
  EscrowNetwork,
  EscrowReadinessProbe,
} from './readiness.js';
import type { SolanaEscrowAccountReader } from './solana-accounts.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2pQd';

export interface EscrowIndexerHealthSource {
  inspect(signal: AbortSignal): Promise<{
    readonly available: boolean;
    readonly lagSlots: bigint;
  }>;
}

export interface EscrowOracleAvailabilitySource {
  availableSigners(signal: AbortSignal): Promise<readonly string[]>;
}

export interface EscrowUpgradeAuthoritySource {
  read(programId: string, signal: AbortSignal): Promise<string | null>;
}

function network(genesisHash: string): EscrowNetwork {
  if (genesisHash === DEVNET_GENESIS) return 'devnet';
  if (genesisHash === MAINNET_GENESIS) return 'mainnet-beta';
  return 'localnet';
}

function mintDecimals(data: Uint8Array): number {
  if (data.length !== 82 || data[45] !== 1) throw new TypeError('invalid classic SPL mint account');
  const decimals = data[44];
  if (decimals === undefined) throw new TypeError('invalid classic SPL mint account');
  return decimals;
}

export class SolanaEscrowReadinessProbe implements EscrowReadinessProbe {
  constructor(
    private readonly connection: Connection,
    private readonly accounts: SolanaEscrowAccountReader,
    private readonly expected: EscrowDeploymentExpectation,
    private readonly indexer: EscrowIndexerHealthSource,
    private readonly oracleAvailability: EscrowOracleAvailabilitySource,
    private readonly upgradeAuthority: EscrowUpgradeAuthoritySource,
  ) {}

  async inspect(signal: AbortSignal): Promise<EscrowDeploymentObservation> {
    signal.throwIfAborted();
    const [genesisHash, programInfo, config, mint, oracleSet, indexer, availableSigners, upgradeAuthority] = await Promise.all([
      this.connection.getGenesisHash(),
      this.connection.getAccountInfo(new PublicKey(this.expected.programId), 'finalized'),
      this.accounts.config(deriveProtocolConfigPda(this.expected.programId).address),
      this.accounts.raw(this.expected.canonicalUsdcMint),
      this.accounts.oracleSet(this.expected.oracleSetPda),
      this.indexer.inspect(signal),
      this.oracleAvailability.availableSigners(signal),
      this.upgradeAuthority.read(this.expected.programId, signal),
    ]);
    signal.throwIfAborted();
    if (programInfo === null || config === null || mint === null || oracleSet === null) {
      throw new TypeError('escrow readiness account unavailable');
    }
    return {
      rpc: { available: true, network: network(genesisHash), genesisHash },
      program: {
        id: this.expected.programId,
        executable: programInfo.executable,
        protocolConfigOwnerProgramId: config.ownerProgramId,
        paused: config.value.paused,
        authorities: {
          configAuthority: config.value.configAuthority,
          pauseAuthority: config.value.pauseAuthority,
          marketCreationAuthority: config.value.marketCreationAuthority,
          upgradeAuthority,
        },
      },
      usdcMint: {
        address: mint.address,
        ownerProgramId: mint.ownerProgramId,
        decimals: mintDecimals(mint.value),
      },
      oracleSet: {
        pda: config.value.oracleSet,
        epoch: oracleSet.value.epoch,
        threshold: oracleSet.value.signatureThreshold,
        signers: oracleSet.value.signers,
        availableSigners,
      },
      indexer,
    };
  }
}
