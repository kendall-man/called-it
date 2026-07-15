export class HarnessConfigurationError extends Error {
  override readonly name = 'HarnessConfigurationError';
}

export class ExpectedTransactionFailureMissingError extends Error {
  override readonly name = 'ExpectedTransactionFailureMissingError';

  constructor(readonly operation: string) {
    super(`expected ${operation} to fail, but it succeeded`);
  }
}

export class AccountUnavailableError extends Error {
  override readonly name = 'AccountUnavailableError';

  constructor(readonly account: string) {
    super(`required account is unavailable: ${account}`);
  }
}

export class ScenarioTimeoutError extends Error {
  override readonly name = 'ScenarioTimeoutError';

  constructor(readonly operation: string) {
    super(`timed out while waiting for ${operation}`);
  }
}

export class IntegrityAssertionError extends Error {
  override readonly name = 'IntegrityAssertionError';
}
