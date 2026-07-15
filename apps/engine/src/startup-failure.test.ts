import { describe, expect, it } from 'vitest';
import { EngineEnvironmentError } from './env.js';
import { EscrowProductionContractError } from './wiring.js';
import { classifyEngineStartFailure } from './startup-failure.js';

describe('classifyEngineStartFailure', () => {
  it('reports environment variable names without values', () => {
    expect(classifyEngineStartFailure(new EngineEnvironmentError(['SOLANA_NETWORK'])))
      .toEqual({ failureKind: 'environment', variables: ['SOLANA_NETWORK'] });
  });

  it('reports the bounded escrow contract code', () => {
    expect(classifyEngineStartFailure(
      new EscrowProductionContractError('deployment_identity_mismatch'),
    )).toEqual({ failureKind: 'escrow_contract', code: 'deployment_identity_mismatch' });
  });

  it('reports only the database operation and structured code', () => {
    const error = Object.assign(new Error('sensitive database detail'), {
      name: 'DbError', op: 'escrow_configure_group_rollout', code: '23503',
    });
    expect(classifyEngineStartFailure(error)).toEqual({
      failureKind: 'database', operation: 'escrow_configure_group_rollout', code: '23503',
    });
  });

  it('does not log arbitrary error messages', () => {
    const result = classifyEngineStartFailure(new Error('contains-sensitive-runtime-data'));
    expect(result).toMatchObject({ failureKind: 'unknown', errorName: 'Error' });
    expect(JSON.stringify(result)).not.toContain('contains-sensitive-runtime-data');
  });
});
