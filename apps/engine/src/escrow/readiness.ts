export type EscrowNetwork = 'localnet' | 'devnet' | 'mainnet-beta';
export type EscrowReadinessMode = 'intake' | 'recovery';

export interface EscrowDeploymentExpectation {
  readonly network: EscrowNetwork;
  readonly genesisHash: string;
  readonly programId: string;
  readonly canonicalUsdcMint: string;
  readonly classicTokenProgramId: string;
  readonly oracleSetPda: string;
  readonly oracleSetEpoch: bigint;
  readonly oracleThreshold: number;
  readonly oracleSigners: readonly string[];
  readonly indexerMaxLagSlots: bigint;
  readonly authorities: EscrowAuthorityExpectation;
}

export interface EscrowAuthorityExpectation {
  readonly configAuthority: string;
  readonly pauseAuthority: string;
  readonly marketCreationAuthority: string;
  readonly upgradeAuthority: string | null;
}

export interface EscrowDeploymentObservation {
  readonly marketCreationAuthoritySigner: string | null;
  readonly rpc: {
    readonly available: boolean;
    readonly network: EscrowNetwork;
    readonly genesisHash: string;
  };
  readonly program: {
    readonly id: string;
    readonly executable: boolean;
    readonly protocolConfigOwnerProgramId: string;
    readonly paused: boolean;
    readonly authorities: EscrowAuthorityExpectation;
  };
  readonly usdcMint: {
    readonly address: string;
    readonly ownerProgramId: string;
    readonly decimals: number;
  };
  readonly oracleSet: {
    readonly pda: string;
    readonly epoch: bigint;
    readonly threshold: number;
    readonly signers: readonly string[];
    readonly availableSigners: readonly string[];
  };
  readonly indexer: {
    readonly available: boolean;
    readonly lagSlots: bigint;
  };
}

export const ESCROW_READINESS_REASONS = [
  'readiness_probe_unavailable',
  'rpc_unavailable',
  'network_mismatch',
  'genesis_hash_mismatch',
  'program_id_mismatch',
  'program_not_executable',
  'program_config_owner_mismatch',
  'authority_expectation_invalid',
  'config_authority_mismatch',
  'pause_authority_mismatch',
  'market_creation_authority_mismatch',
  'market_creation_authority_signer_unavailable',
  'upgrade_authority_mismatch',
  'program_paused',
  'usdc_mint_mismatch',
  'usdc_token_program_mismatch',
  'usdc_decimals_mismatch',
  'oracle_expectation_invalid',
  'oracle_set_pda_mismatch',
  'oracle_set_epoch_mismatch',
  'oracle_threshold_mismatch',
  'oracle_signers_mismatch',
  'oracle_available_signers_invalid',
  'oracle_threshold_unavailable',
  'indexer_unavailable',
  'indexer_lagging',
] as const;

export type EscrowReadinessReason = (typeof ESCROW_READINESS_REASONS)[number];

export type EscrowReadinessReport =
  | { readonly status: 'ready'; readonly reasons: readonly [] }
  | { readonly status: 'not_ready'; readonly reasons: readonly EscrowReadinessReason[] };

export interface EscrowReadinessProbe {
  inspect(signal: AbortSignal): Promise<EscrowDeploymentObservation>;
}

function exactUniqueSetMatches(expected: readonly string[], observed: readonly string[]): boolean {
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  if (expectedSet.size !== expected.length || observedSet.size !== observed.length) return false;
  if (expectedSet.size !== observedSet.size) return false;
  return [...expectedSet].every((value) => observedSet.has(value));
}

function expectationIsValid(expected: EscrowDeploymentExpectation): boolean {
  const uniqueSigners = new Set(expected.oracleSigners);
  return (
    expected.oracleSetEpoch >= 0n &&
    expected.indexerMaxLagSlots >= 0n &&
    Number.isSafeInteger(expected.oracleThreshold) &&
    expected.oracleThreshold > 0 &&
    expected.oracleThreshold <= expected.oracleSigners.length &&
    uniqueSigners.size === expected.oracleSigners.length &&
    [...uniqueSigners].every((signer) => signer.length > 0)
  );
}

function authorityExpectationIsValid(authorities: EscrowAuthorityExpectation): boolean {
  const values = [
    authorities.configAuthority,
    authorities.pauseAuthority,
    authorities.marketCreationAuthority,
    ...(authorities.upgradeAuthority === null ? [] : [authorities.upgradeAuthority]),
  ];
  return values.every((value) => value.length > 0) && new Set(values).size === values.length;
}

function availableSignerSetIsValid(observed: EscrowDeploymentObservation['oracleSet']): boolean {
  const configured = new Set(observed.signers);
  const available = new Set(observed.availableSigners);
  return (
    configured.size === observed.signers.length &&
    available.size === observed.availableSigners.length &&
    [...available].every((signer) => configured.has(signer))
  );
}

export function evaluateEscrowDeployment(
  expected: EscrowDeploymentExpectation,
  observed: EscrowDeploymentObservation,
  mode: EscrowReadinessMode = 'intake',
): EscrowReadinessReport {
  const reasons: EscrowReadinessReason[] = [];
  if (mode === 'intake' && !expectationIsValid(expected)) reasons.push('oracle_expectation_invalid');
  if (!authorityExpectationIsValid(expected.authorities)) {
    reasons.push('authority_expectation_invalid');
  }
  if (!observed.rpc.available) reasons.push('rpc_unavailable');
  if (observed.rpc.network !== expected.network) reasons.push('network_mismatch');
  if (observed.rpc.genesisHash !== expected.genesisHash) reasons.push('genesis_hash_mismatch');
  if (observed.program.id !== expected.programId) reasons.push('program_id_mismatch');
  if (!observed.program.executable) reasons.push('program_not_executable');
  if (observed.program.protocolConfigOwnerProgramId !== expected.programId) {
    reasons.push('program_config_owner_mismatch');
  }
  if (
    observed.program.authorities.configAuthority !== expected.authorities.configAuthority
  ) {
    reasons.push('config_authority_mismatch');
  }
  if (observed.program.authorities.pauseAuthority !== expected.authorities.pauseAuthority) {
    reasons.push('pause_authority_mismatch');
  }
  if (
    observed.program.authorities.marketCreationAuthority !==
    expected.authorities.marketCreationAuthority
  ) {
    reasons.push('market_creation_authority_mismatch');
  }
  if (
    mode === 'intake' &&
    observed.marketCreationAuthoritySigner !== expected.authorities.marketCreationAuthority
  ) reasons.push('market_creation_authority_signer_unavailable');
  if (observed.program.authorities.upgradeAuthority !== expected.authorities.upgradeAuthority) {
    reasons.push('upgrade_authority_mismatch');
  }
  if (mode === 'intake' && observed.program.paused) reasons.push('program_paused');
  if (observed.usdcMint.address !== expected.canonicalUsdcMint) {
    reasons.push('usdc_mint_mismatch');
  }
  if (observed.usdcMint.ownerProgramId !== expected.classicTokenProgramId) {
    reasons.push('usdc_token_program_mismatch');
  }
  if (observed.usdcMint.decimals !== 6) reasons.push('usdc_decimals_mismatch');
  if (mode === 'intake') {
    if (observed.oracleSet.pda !== expected.oracleSetPda) reasons.push('oracle_set_pda_mismatch');
    if (observed.oracleSet.epoch !== expected.oracleSetEpoch) {
      reasons.push('oracle_set_epoch_mismatch');
    }
    if (observed.oracleSet.threshold !== expected.oracleThreshold) {
      reasons.push('oracle_threshold_mismatch');
    }
    if (!exactUniqueSetMatches(expected.oracleSigners, observed.oracleSet.signers)) {
      reasons.push('oracle_signers_mismatch');
    }
    if (!availableSignerSetIsValid(observed.oracleSet)) {
      reasons.push('oracle_available_signers_invalid');
    }
    if (new Set(observed.oracleSet.availableSigners).size < expected.oracleThreshold) {
      reasons.push('oracle_threshold_unavailable');
    }
  }
  if (!observed.indexer.available) reasons.push('indexer_unavailable');
  if (
    observed.indexer.lagSlots < 0n ||
    observed.indexer.lagSlots > expected.indexerMaxLagSlots
  ) {
    reasons.push('indexer_lagging');
  }
  return reasons.length === 0
    ? { status: 'ready', reasons: [] }
    : { status: 'not_ready', reasons };
}

export async function checkEscrowReadiness(options: {
  readonly expected: EscrowDeploymentExpectation;
  readonly probe: EscrowReadinessProbe;
  readonly signal: AbortSignal;
  readonly mode?: EscrowReadinessMode;
}): Promise<EscrowReadinessReport> {
  try {
    options.signal.throwIfAborted();
    const observation = await options.probe.inspect(options.signal);
    options.signal.throwIfAborted();
    return evaluateEscrowDeployment(options.expected, observation, options.mode);
  } catch {
    return { status: 'not_ready', reasons: ['readiness_probe_unavailable'] };
  }
}
