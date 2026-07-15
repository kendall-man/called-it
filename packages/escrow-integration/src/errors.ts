export class HarnessConfigurationError extends Error {
  override readonly name: string = 'HarnessConfigurationError';
}

export class TransactionFailedError extends HarnessConfigurationError {
  override readonly name = 'TransactionFailedError';

  constructor(
    readonly signature: string,
    readonly transactionError: unknown,
  ) {
    super(`transaction ${signature} failed: ${JSON.stringify(transactionError)}`);
  }
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
