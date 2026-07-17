export type RecoveryErrorCode =
  | 'already_recovered'
  | 'blockhash_expired'
  | 'credential_invalid'
  | 'credential_permissions'
  | 'identity_mismatch'
  | 'input_invalid'
  | 'insufficient_fee_balance'
  | 'mint_mismatch'
  | 'network_mismatch'
  | 'not_ready'
  | 'onchain_failure'
  | 'program_mismatch'
  | 'rpc_unavailable'
  | 'submission_forbidden'
  | 'transaction_mismatch';

export class RecoveryError extends Error {
  readonly name = 'RecoveryError';

  constructor(readonly code: RecoveryErrorCode, message: string) {
    super(message);
  }
}

export function fail(code: RecoveryErrorCode, message: string): never {
  throw new RecoveryError(code, message);
}
