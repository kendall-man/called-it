import { describe, expect, it } from 'vitest';
import {
  checkEscrowReadiness,
  evaluateEscrowDeployment,
  type EscrowDeploymentExpectation,
  type EscrowDeploymentObservation,
} from './readiness.js';

const EXPECTED: EscrowDeploymentExpectation = {
  network: 'devnet',
  genesisHash: 'devnet-genesis',
  programId: 'CalledItProgram111111111111111111111111111',
  canonicalUsdcMint: 'CanonicalUsdc1111111111111111111111111111',
  classicTokenProgramId: 'Tokenkeg11111111111111111111111111111111',
  oracleSetPda: 'OracleSet11111111111111111111111111111111',
  oracleSetEpoch: 7n,
  oracleThreshold: 2,
  oracleSigners: ['oracle-a', 'oracle-b', 'oracle-c'],
  indexerMaxLagSlots: 32n,
  authorities: {
    configAuthority: 'config-authority',
    pauseAuthority: 'pause-authority',
    marketCreationAuthority: 'market-authority',
    upgradeAuthority: 'upgrade-authority',
  },
};

const OBSERVED: EscrowDeploymentObservation = {
  rpc: { available: true, network: 'devnet', genesisHash: 'devnet-genesis' },
  program: {
    id: 'CalledItProgram111111111111111111111111111',
    executable: true,
    protocolConfigOwnerProgramId: 'CalledItProgram111111111111111111111111111',
    paused: false,
    authorities: {
      configAuthority: 'config-authority',
      pauseAuthority: 'pause-authority',
      marketCreationAuthority: 'market-authority',
      upgradeAuthority: 'upgrade-authority',
    },
  },
  usdcMint: {
    address: 'CanonicalUsdc1111111111111111111111111111',
    ownerProgramId: 'Tokenkeg11111111111111111111111111111111',
    decimals: 6,
  },
  oracleSet: {
    pda: 'OracleSet11111111111111111111111111111111',
    epoch: 7n,
    threshold: 2,
    signers: ['oracle-c', 'oracle-a', 'oracle-b'],
    availableSigners: ['oracle-a', 'oracle-c'],
  },
  indexer: { available: true, lagSlots: 8n },
};

describe('escrow deployment readiness', () => {
  it('is ready only when deployment identity and operational dependencies match', () => {
    expect(evaluateEscrowDeployment(EXPECTED, OBSERVED)).toEqual({
      status: 'ready',
      reasons: [],
    });
  });

  it.each([
    ['RPC network', { rpc: { ...OBSERVED.rpc, network: 'mainnet-beta' as const } }, 'network_mismatch'],
    ['genesis hash', { rpc: { ...OBSERVED.rpc, genesisHash: 'wrong' } }, 'genesis_hash_mismatch'],
    ['program ID', { program: { ...OBSERVED.program, id: 'wrong' } }, 'program_id_mismatch'],
    ['program executable flag', { program: { ...OBSERVED.program, executable: false } }, 'program_not_executable'],
    [
      'program config owner',
      { program: { ...OBSERVED.program, protocolConfigOwnerProgramId: 'wrong' } },
      'program_config_owner_mismatch',
    ],
    [
      'config authority',
      {
        program: {
          ...OBSERVED.program,
          authorities: { ...OBSERVED.program.authorities, configAuthority: 'wrong' },
        },
      },
      'config_authority_mismatch',
    ],
    [
      'pause authority',
      {
        program: {
          ...OBSERVED.program,
          authorities: { ...OBSERVED.program.authorities, pauseAuthority: 'wrong' },
        },
      },
      'pause_authority_mismatch',
    ],
    [
      'market creation authority',
      {
        program: {
          ...OBSERVED.program,
          authorities: { ...OBSERVED.program.authorities, marketCreationAuthority: 'wrong' },
        },
      },
      'market_creation_authority_mismatch',
    ],
    [
      'upgrade authority',
      {
        program: {
          ...OBSERVED.program,
          authorities: { ...OBSERVED.program.authorities, upgradeAuthority: 'wrong' },
        },
      },
      'upgrade_authority_mismatch',
    ],
    ['program pause', { program: { ...OBSERVED.program, paused: true } }, 'program_paused'],
    ['USDC mint', { usdcMint: { ...OBSERVED.usdcMint, address: 'wrong' } }, 'usdc_mint_mismatch'],
    [
      'USDC token program',
      { usdcMint: { ...OBSERVED.usdcMint, ownerProgramId: 'wrong' } },
      'usdc_token_program_mismatch',
    ],
    ['USDC decimals', { usdcMint: { ...OBSERVED.usdcMint, decimals: 9 } }, 'usdc_decimals_mismatch'],
    ['oracle PDA', { oracleSet: { ...OBSERVED.oracleSet, pda: 'wrong' } }, 'oracle_set_pda_mismatch'],
    ['oracle epoch', { oracleSet: { ...OBSERVED.oracleSet, epoch: 8n } }, 'oracle_set_epoch_mismatch'],
    ['oracle threshold', { oracleSet: { ...OBSERVED.oracleSet, threshold: 3 } }, 'oracle_threshold_mismatch'],
    [
      'oracle members',
      { oracleSet: { ...OBSERVED.oracleSet, signers: ['oracle-a', 'oracle-b', 'oracle-x'] } },
      'oracle_signers_mismatch',
    ],
    [
      'available signer threshold',
      { oracleSet: { ...OBSERVED.oracleSet, availableSigners: ['oracle-a'] } },
      'oracle_threshold_unavailable',
    ],
    ['indexer availability', { indexer: { ...OBSERVED.indexer, available: false } }, 'indexer_unavailable'],
    ['indexer lag', { indexer: { ...OBSERVED.indexer, lagSlots: 33n } }, 'indexer_lagging'],
  ] as const)('fails closed on a %s mismatch', (_name, override, reason) => {
    const observation = { ...OBSERVED, ...override } as EscrowDeploymentObservation;

    expect(evaluateEscrowDeployment(EXPECTED, observation)).toMatchObject({
      status: 'not_ready',
      reasons: expect.arrayContaining([reason]),
    });
  });

  it('fails closed when RPC observation is unavailable', () => {
    expect(
      evaluateEscrowDeployment(EXPECTED, {
        ...OBSERVED,
        rpc: { ...OBSERVED.rpc, available: false },
      }),
    ).toMatchObject({ status: 'not_ready', reasons: expect.arrayContaining(['rpc_unavailable']) });
  });

  it('rejects duplicate configured oracle signers as an invalid oracle set', () => {
    expect(
      evaluateEscrowDeployment(
        { ...EXPECTED, oracleSigners: ['oracle-a', 'oracle-a', 'oracle-c'] },
        OBSERVED,
      ),
    ).toMatchObject({
      status: 'not_ready',
      reasons: expect.arrayContaining(['oracle_expectation_invalid']),
    });
  });

  it('rejects an authority expectation that collapses separate roles', () => {
    expect(
      evaluateEscrowDeployment(
        {
          ...EXPECTED,
          authorities: {
            ...EXPECTED.authorities,
            pauseAuthority: EXPECTED.authorities.configAuthority,
          },
        },
        OBSERVED,
      ),
    ).toMatchObject({
      status: 'not_ready',
      reasons: expect.arrayContaining(['authority_expectation_invalid']),
    });
  });

  it('converts probe failures to not-ready without inventing a fallback', async () => {
    const report = await checkEscrowReadiness({
      expected: EXPECTED,
      signal: new AbortController().signal,
      probe: {
        inspect: async () => {
          throw new Error('RPC details must not escape');
        },
      },
    });

    expect(report).toEqual({ status: 'not_ready', reasons: ['readiness_probe_unavailable'] });
  });

  it('reads observations only through the injected probe', async () => {
    let calls = 0;
    const report = await checkEscrowReadiness({
      expected: EXPECTED,
      signal: new AbortController().signal,
      probe: {
        inspect: async () => {
          calls += 1;
          return OBSERVED;
        },
      },
    });

    expect(calls).toBe(1);
    expect(report.status).toBe('ready');
  });
});
