import { EngineEnvironmentError } from './env.js';
import { EscrowProductionContractError } from './wiring.js';
import { classifySendFailure } from './bot/send-failure.js';

export function classifyEngineStartFailure(error: unknown): Record<string, unknown> {
  const telegram = classifySendFailure(error);
  if (telegram.failureKind !== 'unknown') return telegram;
  if (error instanceof EngineEnvironmentError) {
    return { failureKind: 'environment', variables: error.variables };
  }
  if (error instanceof EscrowProductionContractError) {
    return { failureKind: 'escrow_contract', code: error.code };
  }
  if (
    error instanceof Error && error.name === 'DbError' &&
    'op' in error && typeof error.op === 'string' &&
    (!('code' in error) || error.code === undefined || typeof error.code === 'string')
  ) {
    return {
      failureKind: 'database',
      operation: error.op,
      ...('code' in error && error.code !== undefined ? { code: error.code } : {}),
    };
  }
  return {
    failureKind: 'unknown',
    ...(error instanceof Error
      ? {
          errorName: error.name,
          ...(firstStackFrame(error) === undefined ? {} : { errorLocation: firstStackFrame(error) }),
        }
      : {}),
  };
}

function firstStackFrame(error: Error): string | undefined {
  return error.stack?.split('\n').slice(1).map((line) => line.trim()).find((line) => line.startsWith('at '));
}
